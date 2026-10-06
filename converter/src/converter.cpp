#include "converter.hpp"

#include <BRepBndLib.hxx>
#include <BRepTools.hxx>
#include <Bnd_Box.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <Interface_Static.hxx>
#include <NCollection_DataMap.hxx>
#include <NCollection_Sequence.hxx>
#include <ShapeProcess.hxx>
#include <TCollection_AsciiString.hxx>
#include <TCollection_ExtendedString.hxx>
#include <TDF_Tool.hxx>
#include <TDataStd_Name.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <XCAFDoc_DocumentTool.hxx>

#include <istream>
#include <streambuf>
#include <utility>

#include "json.hpp"
#include "progress.hpp"

namespace {

using LabelSequence = NCollection_Sequence<TDF_Label>;

// An assembly nested deeper than this is a reference cycle in a broken file.
constexpr int kMaxDepth = 256;

// An std::istream over the input bytes, so the STEP parser reads from memory.
struct MemoryBuffer : std::streambuf {
  MemoryBuffer(const uint8_t* data, size_t size) {
    // setg takes non-const pointers; the parser only reads.
    char* begin = const_cast<char*>(reinterpret_cast<const char*>(data));
    setg(begin, begin, begin + size);
  }
};

// The bodies of a part: its solids, else its shells (open surface bodies), else its loose faces.
std::vector<TopoDS_Shape> bodiesOf(const TopoDS_Shape& shape) {
  for (TopAbs_ShapeEnum kind : {TopAbs_SOLID, TopAbs_SHELL, TopAbs_FACE}) {
    std::vector<TopoDS_Shape> found;
    for (TopExp_Explorer explorer(shape, kind); explorer.More(); explorer.Next()) found.push_back(explorer.Current());
    if (!found.empty()) return found;
  }
  return {};
}

// gp_Trsf as a row-major 4x4 matrix.
void rowMajor(const gp_Trsf& trsf, double out[16]) {
  for (int row = 1; row <= 3; ++row) {
    for (int column = 1; column <= 4; ++column) out[(row - 1) * 4 + column - 1] = trsf.Value(row, column);
  }
  out[12] = out[13] = out[14] = 0.0;
  out[15] = 1.0;
}

void bounds(const TopoDS_Shape& shape, double out[6]) {
  Bnd_Box box;
  BRepBndLib::Add(shape, box, false);
  if (box.IsVoid()) return;
  box.Get(out[0], out[1], out[2], out[3], out[4], out[5]);
}

std::string unitName(TCollection_AsciiString raw) {
  raw.LowerCase();
  std::string name = raw.ToCString();
  static const std::pair<const char*, const char*> known[] = {
    {"millimetre", "mm"}, {"centimetre", "cm"}, {"metre", "m"}, {"micrometre", "um"}, {"kilometre", "km"},
    {"inch", "inch"},     {"foot", "ft"},       {"mile", "mile"}};
  for (const auto& [from, to] : known) {
    if (name == from) return to;
  }
  return name;
}

// OpenCascade names an instance the file left unnamed after the label it refers to, as "=>[0:1:1:2]"; the occurrence
// takes its component's name instead.
bool placeholder(const std::string& name) {
  if (name.size() < 5 || name.compare(0, 3, "=>[") != 0 || name.back() != ']') return false;
  return name.find_first_not_of("0123456789:", 3) == name.size() - 1;
}

} // namespace

struct Converter::SubShapeColours {
  NCollection_DataMap<TopoDS_Shape, Quantity_ColorRGBA, TopTools_ShapeMapHasher> map;
};

std::string labelName(const TDF_Label& label) {
  Handle(TDataStd_Name) name;
  if (!label.FindAttribute(TDataStd_Name::GetID(), name)) return {};
  const TCollection_AsciiString utf8(name->Get());
  return std::string(utf8.ToCString(), utf8.Length());
}

std::string labelEntry(const TDF_Label& label) {
  TCollection_AsciiString entry;
  TDF_Tool::Entry(label, entry);
  return entry.ToCString();
}

uint8_t* Converter::allocInput(uint32_t size) {
  std::vector<uint8_t>().swap(input_);
  input_.resize(size);
  return input_.data();
}

void Converter::read() {
  if (input_.empty()) throw BadInput("no STEP bytes: the file is empty, or conv_alloc was not called");
  // The bytes are freed when this returns, on success or by exception.
  const std::vector<uint8_t> bytes = std::move(input_);
  input_ = {};
  // A new file starts clean whether or not the last one was closed. A read that fails, by status or by an
  // exception out of the parser, leaves no reader behind for conv_transfer: reader_ is set on success only.
  close();
  // The start report is the host's only chance to stop a read: the parser takes no progress range and runs to
  // the end once started.
  Progress progress(Phase::read);
  Interface_Static::SetCVal("xstep.cascade.unit", "MM");
  auto reader = std::make_unique<STEPCAFControl_Reader>();
  reader->SetColorMode(true);
  reader->SetNameMode(true);
  MemoryBuffer buffer(bytes.data(), bytes.size());
  std::istream stream(&buffer);
  if (reader->ReadStream("model.step", stream) != IFSelect_RetDone) throw BadInput("not a STEP file this reader can parse");
  reader_ = std::move(reader);
}

int32_t Converter::transfer() {
  if (!reader_) throw BadInput("conv_transfer: nothing read, call conv_read first");
  try {
    // OpenCascade's transfer is the first 90% of the phase, the tree walk below the rest.
    Handle(Progress) progress = new Progress(Phase::transfer, 0.9);
    document_ = new TDocStd_Document("XmlOcaf");
    if (!options.healing) reader_->ChangeReader().SetShapeProcessFlags(ShapeProcess::OperationsFlags());
    // On a stop OpenCascade's scopes leave their loops and Transfer returns false before it fills the document,
    // which then holds only the length unit. The shapes translated so far sit in the reader's transfer process,
    // with the actor's unit context, which the interrupted entity did not restore. Both go when close() below
    // drops the reader; the next conv_read makes a new one.
    const bool transferred = reader_->Transfer(document_, progress->Start());
    progress->throwIfStopped();
    if (!transferred) throw BadInput("the file has no shape to transfer");
    sourceUnit_ = sourceUnit();
    reader_.reset();

    shapes_ = XCAFDoc_DocumentTool::ShapeTool(document_->Main());
    colours_ = XCAFDoc_DocumentTool::ColorTool(document_->Main());
    LabelSequence roots;
    shapes_->GetFreeShapes(roots);
    if (roots.IsEmpty()) throw BadInput("the file has no shape");

    LabelSequence labels;
    shapes_->GetShapes(labels);
    Walk walk{{}, *progress, labels.Length()};
    docName_ = labelName(roots.First());
    if (docName_.empty()) docName_ = labelEntry(roots.First());
    for (int i = 1; i <= roots.Length(); ++i) addRoot(roots.Value(i), roots.Length() > 1, walk);
    siblingNames_.clear();
    resolveFaceColours(walk.colours);
    return solidCount();
  } catch (...) {
    // Nothing half-built stays behind, so the next file starts clean.
    close();
    throw;
  }
}

void Converter::addRoot(const TDF_Label& root, bool several, Walk& walk) {
  const gp_Trsf identity;
  if (!several) {
    if (XCAFDoc_ShapeTool::IsAssembly(root)) addComponents(root, -1, identity, 0, walk);
    else addBodies(root, root, -1, walk);
    return;
  }
  // With several free shapes each becomes a top-level occurrence, so nothing is dropped.
  Occurrence occurrence;
  occurrence.component = labelName(root);
  occurrence.name = uniqueName(occurrence.component.empty() ? labelEntry(root) : occurrence.component, -1);
  occurrence.path = occurrence.name;
  const gp_Trsf trsf = XCAFDoc_ShapeTool::GetLocation(root).Transformation();
  rowMajor(trsf, occurrence.matrix);
  occurrences_.push_back(std::move(occurrence));
  const int index = static_cast<int>(occurrences_.size()) - 1;
  if (XCAFDoc_ShapeTool::IsAssembly(root)) addComponents(root, index, trsf, 1, walk);
  else addBodies(root, root, index, walk);
}

void Converter::addComponents(const TDF_Label& assembly, int parent, const gp_Trsf& parentTrsf, int depth,
                              Walk& walk) {
  if (depth >= kMaxDepth) {
    warnings.add("assembly nested deeper than " + std::to_string(kMaxDepth) + " levels, cut at " +
                 occurrences_[parent].path);
    return;
  }
  LabelSequence components;
  XCAFDoc_ShapeTool::GetComponents(assembly, components);
  for (int i = 1; i <= components.Length(); ++i) {
    const TDF_Label& instance = components.Value(i);
    TDF_Label prototype;
    if (!XCAFDoc_ShapeTool::GetReferredShape(instance, prototype)) {
      warnings.add("component " + labelEntry(instance) + " refers to no shape, skipped");
      continue;
    }
    Occurrence occurrence;
    occurrence.component = labelName(prototype);
    std::string name = labelName(instance);
    if (name.empty()) name = occurrence.component + ":" + std::to_string(i);
    else if (placeholder(name)) name = occurrence.component;
    occurrence.name = uniqueName(name, parent);
    occurrence.path = parent < 0 ? occurrence.name : occurrences_[parent].path + "+" + occurrence.name;
    occurrence.parent = parent;
    const gp_Trsf trsf = parentTrsf.Multiplied(XCAFDoc_ShapeTool::GetLocation(instance).Transformation());
    rowMajor(trsf, occurrence.matrix);
    occurrences_.push_back(std::move(occurrence));
    const int index = static_cast<int>(occurrences_.size()) - 1;
    if (XCAFDoc_ShapeTool::IsAssembly(prototype)) addComponents(prototype, index, trsf, depth + 1, walk);
    else addBodies(prototype, instance, index, walk);
  }
}

// Sibling occurrences need distinct paths: a repeated name gets :2, :3, ... appended.
std::string Converter::uniqueName(const std::string& wanted, int parent) {
  auto& taken = siblingNames_[parent];
  std::string name = wanted;
  for (int n = 2; taken.count(name); ++n) name = wanted + ":" + std::to_string(n);
  taken.insert(name);
  return name;
}

void Converter::addBodies(const TDF_Label& prototype, const TDF_Label& instance, int occurrence, Walk& walk) {
  const TopoDS_Shape part = XCAFDoc_ShapeTool::GetShape(prototype);
  const std::vector<TopoDS_Shape> found = bodiesOf(part);
  if (found.empty()) return;
  const int first = firstSolidOf(prototype, found, walk);
  const SubShapeColours& colours = subShapeColours(prototype, walk.colours);
  const std::string& component = solids_[first].component;
  for (size_t index = 0; index < found.size(); ++index) {
    Solid& solid = solids_[first + index];
    solid.body = found.size() == 1 ? component : component + " (" + std::to_string(index + 1) + ")";
    Body body;
    body.occurrence = occurrence;
    body.name = solid.body;
    body.mesh = first + static_cast<int>(index);
    body.appearance = bodyAppearance(found[index], part, prototype, instance, colours);
    bodies_.push_back(std::move(body));
  }
}

// Instances share their prototype's solids: the first instance creates them.
int Converter::firstSolidOf(const TDF_Label& prototype, const std::vector<TopoDS_Shape>& bodies, Walk& walk) {
  const std::string entry = labelEntry(prototype);
  auto found = firstSolid_.find(entry);
  if (found != firstSolid_.end()) return found->second;
  // A part's maps, bounds and colours take the walk's time, so a report before each lets a stop land between parts.
  walk.progress.report(static_cast<double>(firstSolid_.size()), walk.labels);
  const int first = solidCount();
  firstSolid_.emplace(entry, first);
  const std::string component = labelName(prototype);
  for (const TopoDS_Shape& body : bodies) {
    Solid solid;
    solid.shape = body;
    solid.component = component;
    TopExp::MapShapes(body, TopAbs_FACE, solid.faceMap);
    bounds(body, solid.bbox);
    solids_.push_back(std::move(solid));
    prototypeOf_.push_back(prototype);
  }
  return first;
}

bool Converter::labelColour(const TDF_Label& label, Quantity_ColorRGBA& colour) const {
  return colours_->GetColor(label, XCAFDoc_ColorSurf, colour) || colours_->GetColor(label, XCAFDoc_ColorGen, colour);
}

// The colours of a part's sub-shapes (faces, solids of a compound), keyed by the sub-shape as XCAF stores it.
const Converter::SubShapeColours& Converter::subShapeColours(const TDF_Label& prototype, ColourCache& cache) const {
  std::unique_ptr<SubShapeColours>& slot = cache[labelEntry(prototype)];
  if (slot) return *slot;
  slot = std::make_unique<SubShapeColours>();
  LabelSequence subShapes;
  XCAFDoc_ShapeTool::GetSubShapes(prototype, subShapes);
  for (int i = 1; i <= subShapes.Length(); ++i) {
    Quantity_ColorRGBA colour;
    if (labelColour(subShapes.Value(i), colour)) slot->map.Bind(XCAFDoc_ShapeTool::GetShape(subShapes.Value(i)), colour);
  }
  return *slot;
}

// The body's own colour, else its part's, else its instance's, else the first coloured face's: Fusion often
// colours faces rather than bodies.
int Converter::bodyAppearance(const TopoDS_Shape& body, const TopoDS_Shape& part, const TDF_Label& prototype,
                              const TDF_Label& instance, const SubShapeColours& colours) {
  // A body that is the whole part carries the part's colour, which the next lookup finds.
  const Quantity_ColorRGBA* own = body.IsSame(part) ? nullptr : colours.map.Seek(body);
  if (own) return appearances.add(*own);
  Quantity_ColorRGBA colour;
  if (labelColour(prototype, colour) || labelColour(instance, colour)) return appearances.add(colour);
  for (TopExp_Explorer explorer(body, TopAbs_FACE); explorer.More(); explorer.Next()) {
    if (const Quantity_ColorRGBA* face = colours.map.Seek(explorer.Current())) return appearances.add(*face);
  }
  return -1;
}

// Face colours come after the body colours, in mesh order, so the appearance table is in the oracle's order.
void Converter::resolveFaceColours(ColourCache& cache) {
  for (size_t i = 0; i < solids_.size(); ++i) {
    Solid& solid = solids_[i];
    const SubShapeColours& colours = subShapeColours(prototypeOf_[i], cache);
    for (TopExp_Explorer explorer(solid.shape, TopAbs_FACE); explorer.More(); explorer.Next()) {
      const Quantity_ColorRGBA* colour = colours.map.Seek(explorer.Current());
      solid.faceAppearance.push_back(colour ? appearances.add(*colour) : -1);
    }
  }
}

std::string Converter::sourceUnit() {
  NCollection_Sequence<TCollection_AsciiString> lengths, angles, solidAngles;
  reader_->ChangeReader().FileUnits(lengths, angles, solidAngles);
  return lengths.IsEmpty() ? std::string("mm") : unitName(lengths.First());
}

void Converter::writeTree(std::string& out) const {
  JsonWriter json(out);
  json.beginObject();
  json.key("doc");
  json.value(docName_);
  json.key("units");
  json.value("mm");
  json.key("source_unit");
  json.value(sourceUnit_);

  json.key("occurrences");
  json.beginArray();
  for (const Occurrence& occurrence : occurrences_) {
    json.beginObject();
    json.key("path");
    json.value(occurrence.path);
    json.key("parent");
    if (occurrence.parent < 0) json.null();
    else json.value(occurrences_[occurrence.parent].path);
    json.key("name");
    json.value(occurrence.name);
    json.key("component");
    json.value(occurrence.component);
    json.key("linked");
    json.value(false);
    json.key("visible");
    json.value(true);
    json.key("matrix");
    json.beginArray();
    for (double v : occurrence.matrix) json.value(v);
    json.endArray();
    json.endObject();
  }
  json.endArray();

  json.key("bodies");
  json.beginArray();
  for (const Body& body : bodies_) {
    json.beginObject();
    json.key("occ");
    if (body.occurrence < 0) json.null();
    else json.value(occurrences_[body.occurrence].path);
    json.key("body");
    json.value(body.name);
    json.key("mesh");
    json.value(body.mesh);
    json.key("appearance");
    if (body.appearance < 0) json.null();
    else json.value(appearances.list()[body.appearance].name);
    json.endObject();
  }
  json.endArray();

  json.key("meshes");
  json.beginArray();
  for (const Solid& solid : solids_) {
    json.beginObject();
    json.key("component");
    json.value(solid.component);
    json.key("body");
    json.value(solid.body);
    json.key("faces");
    json.value(solid.faceMap.Extent());
    json.key("bbox");
    json.beginArray();
    for (double v : solid.bbox) json.value(v);
    json.endArray();
    json.endObject();
  }
  json.endArray();

  json.key("appearances");
  json.beginObject();
  for (const Appearance& appearance : appearances.list()) {
    json.key(appearance.name);
    json.beginArray();
    json.beginArray();
    json.value("interior_model");
    json.value("integer");
    json.value(appearance.opaque ? 0 : 3);
    json.endArray();
    json.beginArray();
    json.value(appearance.opaque ? "opaque_albedo" : "transparent_color");
    json.value("color");
    json.beginArray();
    json.value(appearance.r);
    json.value(appearance.g);
    json.value(appearance.b);
    json.value(255);
    json.endArray();
    json.endArray();
    json.beginArray();
    json.value("surface_roughness");
    json.value("float");
    json.value(appearance.opaque ? 0.45 : 0.05);
    json.endArray();
    json.endArray();
  }
  json.endObject();
  json.key("appearance_order");
  json.beginArray();
  for (const Appearance& appearance : appearances.list()) json.value(appearance.name);
  json.endArray();

  json.key("fastener_partners");
  json.beginObject();
  json.endObject();
  json.key("sliders");
  json.beginObject();
  json.endObject();
  json.key("params");
  json.beginObject();
  json.endObject();
  json.endObject();
}

void Solid::mapEdgesAndVertices() {
  if (!edgeMap.IsEmpty()) return;
  TopExp::MapShapes(shape, TopAbs_EDGE, edgeMap);
  TopExp::MapShapes(shape, TopAbs_VERTEX, vertexMap);
}

Solid& Converter::solid(int32_t index) {
  if (index < 0 || index >= solidCount()) throw BadInput("no solid " + std::to_string(index));
  return solids_[index];
}

void Converter::release(int32_t index) {
  if (index < 0 || index >= solidCount()) throw BadInput("no solid " + std::to_string(index));
  BRepTools::Clean(solids_[index].shape);
}

void Converter::close() {
  std::vector<uint8_t>().swap(input_);
  reader_.reset();
  solids_.clear();
  prototypeOf_.clear();
  firstSolid_.clear();
  bodies_.clear();
  occurrences_.clear();
  appearances.clear();
  docName_.clear();
  sourceUnit_ = "mm";
  colours_.Nullify();
  shapes_.Nullify();
  document_.Nullify();
}
