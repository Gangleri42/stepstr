// The converter's state between ABI calls: the parsed file, the XCAF document, the tree and the prototype solids.
#pragma once

#include <NCollection_IndexedMap.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <TDF_Label.hxx>
#include <TDocStd_Document.hxx>
#include <TopTools_ShapeMapHasher.hxx>
#include <TopoDS_Shape.hxx>
#include <XCAFDoc_ColorTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <gp_Trsf.hxx>

#include <cstdint>
#include <deque>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "appearance.hpp"
#include "warnings.hpp"

class Progress;

using ShapeMap = NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher>;

// Rejected input or a call out of sequence: error code -1.
struct BadInput : std::runtime_error {
  using runtime_error::runtime_error;
};

struct Options {
  bool healing = true;
  bool normals = true;
  int32_t geometryFaceLimit = 20000;
};

struct Occurrence {
  std::string path;
  int parent = -1; // index into the occurrences, -1 at the top
  std::string name;
  std::string component;
  double matrix[16];
};

struct Body {
  int occurrence = -1; // -1: a body of the root part
  std::string name;
  int mesh = 0;
  int appearance = -1; // index into the appearances, -1: none
};

// One prototype body: what conv_mesh and conv_geometry work on.
struct Solid {
  TopoDS_Shape shape;
  std::string component;
  std::string body;
  double bbox[6] = {0, 0, 0, 0, 0, 0};
  // Per face in TopExp_Explorer order, the order meshes are written in: appearance index, -1 for the body's own.
  std::vector<int32_t> faceAppearance;
  ShapeMap faceMap; // TopExp::MapShapes(shape, FACE): a face's 0-based index here is its id
  ShapeMap edgeMap;   // filled by mapEdgesAndVertices, which only the geometry needs
  ShapeMap vertexMap;

  void mapEdgesAndVertices();
};

class Converter {
public:
  // The file's bytes go to a buffer the converter owns; read() parses and frees them, dropping any earlier file.
  uint8_t* allocInput(uint32_t size);
  void read();
  // Builds the document, the tree and the appearances; returns the solid count.
  int32_t transfer();
  void writeTree(std::string& out) const;
  bool loaded() const { return !document_.IsNull(); }
  Solid& solid(int32_t index);
  int32_t solidCount() const { return static_cast<int32_t>(solids_.size()); }
  void release(int32_t index);
  void close();

  Options options;
  Warnings warnings;
  Appearances appearances;

private:
  struct SubShapeColours;
  using ColourCache = std::unordered_map<std::string, std::unique_ptr<SubShapeColours>>;
  // What the tree walk carries along: the parts' sub-shape colours, and the progress, reported once per part
  // visited against the count of shape labels in the document.
  struct Walk {
    ColourCache colours;
    Progress& progress;
    int labels;
  };

  void addRoot(const TDF_Label& root, bool several, Walk& walk);
  void addComponents(const TDF_Label& assembly, int parent, const gp_Trsf& parentTrsf, int depth, Walk& walk);
  void addBodies(const TDF_Label& prototype, const TDF_Label& instance, int occurrence, Walk& walk);
  int firstSolidOf(const TDF_Label& prototype, const std::vector<TopoDS_Shape>& bodies, Walk& walk);
  int bodyAppearance(const TopoDS_Shape& body, const TopoDS_Shape& part, const TDF_Label& prototype,
                     const TDF_Label& instance, const SubShapeColours& colours);
  bool labelColour(const TDF_Label& label, Quantity_ColorRGBA& colour) const;
  const SubShapeColours& subShapeColours(const TDF_Label& prototype, ColourCache& cache) const;
  void resolveFaceColours(ColourCache& cache);
  std::string uniqueName(const std::string& wanted, int parent);
  std::string sourceUnit();

  std::vector<uint8_t> input_;
  std::unique_ptr<STEPCAFControl_Reader> reader_;
  Handle(TDocStd_Document) document_;
  Handle(XCAFDoc_ShapeTool) shapes_;
  Handle(XCAFDoc_ColorTool) colours_;

  std::string docName_;
  std::string sourceUnit_ = "mm";
  std::vector<Occurrence> occurrences_;
  std::vector<Body> bodies_;
  std::deque<Solid> solids_; // a deque: solids hold maps, which must not move
  std::vector<TDF_Label> prototypeOf_;                                      // per solid
  std::unordered_map<std::string, int> firstSolid_;                         // prototype entry -> first solid
  std::unordered_map<int, std::unordered_set<std::string>> siblingNames_;  // parent occurrence -> names taken
};

// The label's TDataStd_Name as UTF-8, empty when it has none.
std::string labelName(const TDF_Label& label);
// The label's entry, e.g. 0:1:1:3.
std::string labelEntry(const TDF_Label& label);
