#include "mesh.hpp"

#include <BRepBuilderAPI_NurbsConvert.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepTools.hxx>
#include <BRep_Tool.hxx>
#include <GeomLib.hxx>
#include <Geom_Surface.hxx>
#include <IMeshTools_Parameters.hxx>
#include <Poly_Connect.hxx>
#include <Poly_Triangulation.hxx>
#include <Precision.hxx>
#include <Standard_Failure.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <gp_Dir.hxx>
#include <gp_Mat.hxx>

#include <algorithm>
#include <cstring>
#include <limits>
#include <numeric>
#include <stdexcept>

#include "progress.hpp"

namespace {

// One face's share of the mesh.
struct Patch {
  Handle(Poly_Triangulation) triangulation;
  TopoDS_Face face; // the face that was meshed: the original or its NURBS copy
  gp_Trsf trsf;     // the face's location
  bool located = false;
  bool reversed = false;
  int32_t id = -1;
  int32_t appearance = -1;
  uint32_t base = 0; // its first node in the output
};

// Little-endian writes into the result buffer.
class Cursor {
public:
  explicit Cursor(char* at) : at_(at) {}
  void u32(uint32_t value) { put(&value); }
  void i32(int32_t value) { put(&value); }
  void f32(float value) { put(&value); }
  void point(const gp_XYZ& p) {
    f32(static_cast<float>(p.X()));
    f32(static_cast<float>(p.Y()));
    f32(static_cast<float>(p.Z()));
  }
  char* at() const { return at_; }

private:
  template <class T> void put(const T* value) {
    std::memcpy(at_, value, sizeof(T));
    at_ += sizeof(T);
  }
  char* at_;
};

IMeshTools_Parameters meshParameters(double linear, double angular) {
  IMeshTools_Parameters parameters;
  parameters.Deflection = linear;
  parameters.Angle = angular;
  parameters.Relative = false;
  parameters.InParallel = false;
  return parameters;
}

// BRepMesh gives up on some analytic faces (a cone whose parameter range reaches its apex); the same face as a
// NURBS surface meshes fine. A null face when even that fails, or when the face has no surface to convert.
TopoDS_Face remeshAsNurbs(const TopoDS_Face& face, const IMeshTools_Parameters& parameters) {
  if (BRep_Tool::Surface(face).IsNull()) return {};
  try {
    TopoDS_Face nurbs = TopoDS::Face(BRepBuilderAPI_NurbsConvert(face, true).Shape());
    BRepMesh_IncrementalMesh(nurbs, parameters);
    return nurbs;
  } catch (const Standard_Failure&) {
    return {};
  }
}

// The average of the normals of the triangles around a node, for nodes where the surface has no normal
// (an apex, a pole). Z when the node has no triangle with an area.
gp_Dir averagedNormal(const Handle(Poly_Triangulation)& triangulation, Poly_Connect& connect, int node) {
  if (connect.Triangulation() != triangulation) connect.Load(triangulation);
  constexpr double tolerance = Precision::Confusion();
  gp_XYZ sum(0, 0, 0);
  int a, b, c;
  for (connect.Initialize(node); connect.More(); connect.Next()) {
    triangulation->Triangle(connect.Value()).Get(a, b, c);
    const gp_XYZ ab = triangulation->Node(b).Coord() - triangulation->Node(a).Coord();
    const gp_XYZ bc = triangulation->Node(c).Coord() - triangulation->Node(b).Coord();
    const gp_XYZ cross = ab ^ bc;
    const double length = cross.Modulus();
    if (length >= tolerance) sum += cross / length;
  }
  return sum.Modulus() > tolerance ? gp_Dir(sum) : gp::DZ();
}

// Unit normals of the exact surface at the patch's nodes, in the solid's frame, on the side the triangles face:
// out of the material when the solid's faces are oriented consistently.
void writeNormals(const Patch& patch, Cursor& cursor) {
  const Handle(Poly_Triangulation)& triangulation = patch.triangulation;
  // The nodes are in the face's own frame, and so is this surface; the location is applied at the end.
  const Handle(Geom_Surface) surface = BRep_Tool::Surface(TopoDS::Face(patch.face.Located(TopLoc_Location())));
  const bool fromSurface = !surface.IsNull() && triangulation->HasUVNodes();
  // BRepMesh winds the triangles with the surface's parametric normal, and writeMesh swaps two corners on a
  // reversed face. A location moves each edge of a triangle by scale * rotation, so it moves the winding normal
  // by the rotation alone: the scale, -1 for a mirror, squares away. So the normals follow the rotation and the
  // face orientation, not gp_Trsf::IsNegative, which would turn them against the winding. The determinant covers
  // the one way gp_Trsf holds an improper rotation, a transformation built from a left-handed gp_Ax3.
  // OpenCascade's own StdPrs_ShadedShape computes the same normals.
  const gp_Mat rotation = patch.trsf.HVectorialPart();
  const bool flip = patch.reversed != (rotation.Determinant() < 0);
  Poly_Connect connect;
  for (int node = 1; node <= triangulation->NbNodes(); ++node) {
    gp_Dir normal;
    const bool exact =
      fromSurface && GeomLib::NormEstim(surface, triangulation->UVNode(node), Precision::Confusion(), normal) <= 1;
    if (!exact) normal = averagedNormal(triangulation, connect, node);
    gp_XYZ n = normal.XYZ();
    if (patch.located) n = rotation * n;
    if (flip) n.Reverse();
    cursor.point(n);
  }
}

} // namespace

void writeMesh(Solid& solid, double linear, double angular, bool normals, const Appearances& appearances,
               Warnings& warnings, std::string& out) {
  const IMeshTools_Parameters parameters = meshParameters(linear, angular);
  // BRepMesh is the first 90% of the phase, the normals below the rest.
  Handle(Progress) progress = new Progress(Phase::mesh, 0.9);
  BRepMesh_IncrementalMesh(solid.shape, parameters, progress->Start());
  if (progress->stopped()) {
    // BRepMesh has stored the triangulations of the faces it finished, but the edges' polygons on them only come
    // at the end: drop the half-built mesh, so the next call starts from scratch like a fresh one.
    BRepTools::Clean(solid.shape);
    progress->throwIfStopped();
  }

  std::vector<Patch> patches;
  patches.reserve(solid.faceAppearance.size());
  uint64_t nodes = 0, triangles = 0;
  int remeshed = 0, unmeshed = 0;
  size_t index = 0;
  for (TopExp_Explorer explorer(solid.shape, TopAbs_FACE); explorer.More(); explorer.Next(), ++index) {
    TopoDS_Face face = TopoDS::Face(explorer.Current());
    Patch patch;
    patch.id = solid.faceMap.FindIndex(face) - 1;
    patch.appearance = index < solid.faceAppearance.size() ? solid.faceAppearance[index] : -1;
    TopLoc_Location location;
    patch.triangulation = BRep_Tool::Triangulation(face, location);
    if (patch.triangulation.IsNull()) {
      face = remeshAsNurbs(face, parameters);
      if (!face.IsNull()) patch.triangulation = BRep_Tool::Triangulation(face, location);
      if (patch.triangulation.IsNull()) {
        ++unmeshed;
        continue;
      }
      ++remeshed;
    }
    patch.face = face;
    patch.trsf = location.Transformation();
    patch.located = !location.IsIdentity();
    patch.reversed = face.Orientation() == TopAbs_REVERSED;
    patch.base = static_cast<uint32_t>(nodes);
    nodes += patch.triangulation->NbNodes();
    triangles += patch.triangulation->NbTriangles();
    patches.push_back(std::move(patch));
  }
  if (remeshed) warnings.add(solid.body + ": " + std::to_string(remeshed) + " face(s) meshed as NURBS after BRepMesh gave up");
  if (unmeshed) warnings.add(solid.body + ": " + std::to_string(unmeshed) + " face(s) could not be meshed and are missing");

  // Triangles come grouped by colour: the body's own colour first, then face colours by name.
  std::vector<int32_t> groups;
  for (const Patch& patch : patches) {
    if (std::find(groups.begin(), groups.end(), patch.appearance) == groups.end()) groups.push_back(patch.appearance);
  }
  std::sort(groups.begin(), groups.end(), [&](int32_t a, int32_t b) {
    if (a < 0 || b < 0) return a < b;
    return appearances.list()[a].name < appearances.list()[b].name;
  });
  auto rankOf = [&](int32_t appearance) {
    return static_cast<uint32_t>(std::find(groups.begin(), groups.end(), appearance) - groups.begin());
  };
  std::vector<size_t> order(patches.size());
  std::iota(order.begin(), order.end(), 0);
  std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) {
    return rankOf(patches[a].appearance) < rankOf(patches[b].appearance);
  });
  std::vector<uint32_t> groupTriangles(groups.size(), 0);
  for (const Patch& patch : patches) groupTriangles[rankOf(patch.appearance)] += patch.triangulation->NbTriangles();

  // Sizes in 64 bits: on wasm32 a size_t wraps past 4 GB, and the ABI returns the length as an i32 anyway.
  const uint64_t positionsBytes = 12 * nodes, indicesBytes = 12 * triangles, idsBytes = 4 * triangles;
  const uint64_t size = 8 + positionsBytes + indicesBytes + idsBytes + 4 + 8 * groups.size() + 4 +
                        (normals ? positionsBytes : 0);
  if (size > static_cast<uint64_t>(std::numeric_limits<int32_t>::max())) {
    throw std::runtime_error(solid.body + ": mesh larger than 2 GB");
  }
  out.resize(static_cast<size_t>(size));
  Cursor cursor(out.data());
  cursor.u32(static_cast<uint32_t>(nodes));
  cursor.u32(static_cast<uint32_t>(triangles));
  for (const Patch& patch : patches) {
    const Handle(Poly_Triangulation)& triangulation = patch.triangulation;
    for (int node = 1; node <= triangulation->NbNodes(); ++node) {
      gp_XYZ p = triangulation->Node(node).XYZ();
      if (patch.located) patch.trsf.Transforms(p);
      cursor.point(p);
    }
  }
  Cursor ids(cursor.at() + static_cast<size_t>(indicesBytes));
  for (size_t i : order) {
    const Patch& patch = patches[i];
    const Handle(Poly_Triangulation)& triangulation = patch.triangulation;
    int a, b, c;
    for (int triangle = 1; triangle <= triangulation->NbTriangles(); ++triangle) {
      triangulation->Triangle(triangle).Get(a, b, c);
      if (patch.reversed) std::swap(b, c);
      cursor.u32(patch.base + a - 1);
      cursor.u32(patch.base + b - 1);
      cursor.u32(patch.base + c - 1);
      ids.u32(static_cast<uint32_t>(patch.id));
    }
  }
  cursor = ids;
  cursor.u32(static_cast<uint32_t>(groups.size()));
  for (int32_t appearance : groups) cursor.i32(appearance);
  for (uint32_t count : groupTriangles) cursor.u32(count);
  cursor.u32(normals ? 1 : 0);
  if (normals) {
    uint64_t done = 0;
    for (const Patch& patch : patches) {
      writeNormals(patch, cursor);
      done += patch.triangulation->NbNodes();
      progress->report(static_cast<double>(done), static_cast<double>(nodes));
    }
  }
}
