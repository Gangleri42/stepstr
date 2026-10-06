// A port of the oracle's write_measure: the same records from the same OpenCascade calls in the same order, so
// the numbers agree to the last bits the platform's libm allows.
#include "geometry.hpp"

#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepGProp.hxx>
#include <BRepTools.hxx>
#include <BRep_Tool.hxx>
#include <GCPnts_AbscissaPoint.hxx>
#include <GCPnts_TangentialDeflection.hxx>
#include <GProp_GProps.hxx>
#include <ShapeAnalysis_CanonicalRecognition.hxx>
#include <Standard_Failure.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Wire.hxx>
#include <gp_Circ.hxx>
#include <gp_Cone.hxx>
#include <gp_Cylinder.hxx>
#include <gp_Lin.hxx>
#include <gp_Pln.hxx>
#include <gp_Sphere.hxx>
#include <gp_Torus.hxx>

#include <algorithm>
#include <cmath>
#include <unordered_map>

#include "json.hpp"
#include "progress.hpp"

namespace {

// A BSpline face or edge counts as a plane, cylinder, circle... only this close to one (mm).
constexpr double kRecognitionTolerance = 1e-4;
// Deflection of the polyline written for a free-form edge, mm.
constexpr double kPolylineDeflection = 0.005;
// The measurement data keeps an arc's sweep to 6 decimals, so below this nothing is left of it (rad).
constexpr double kMinSweep = 5e-7;
// A circle fitted to a nearly straight edge can be kilometres wide, and at 6 decimals of sweep a wide arc loses
// length (radius * 5e-7). An arc this wide or wider is written as the line or curve it is (mm).
constexpr double kMaxRadius = 20000;
constexpr double kTwoPi = 2 * M_PI;

// -- the oracle's small vector helpers, operation for operation --------------------------------------------------

struct Vec {
  double x, y, z;
};

Vec xyz(const gp_Pnt& p) { return {p.X(), p.Y(), p.Z()}; }
Vec xyz(const gp_Dir& d) { return {d.X(), d.Y(), d.Z()}; }
Vec xyz(const gp_Vec& v) { return {v.X(), v.Y(), v.Z()}; }
Vec add(const Vec& a, const Vec& b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
Vec sub(const Vec& a, const Vec& b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
Vec scale(const Vec& a, double s) { return {a.x * s, a.y * s, a.z * s}; }
double dot(const Vec& a, const Vec& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
Vec cross(const Vec& a, const Vec& b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
Vec unit(const Vec& a) {
  const double length = std::sqrt(dot(a, a));
  return length > 0 ? scale(a, 1 / length) : a;
}
// The part of p - origin perpendicular to the axis.
Vec radial(const Vec& p, const Vec& origin, const Vec& axis) {
  const Vec v = sub(p, origin);
  return sub(v, scale(axis, dot(v, axis)));
}
double dist(const Vec& a, const Vec& b) {
  const Vec d = sub(a, b);
  return std::sqrt(dot(d, d));
}
double sign(double value) { return value >= 0 ? 1 : -1; }
// Python's % for a positive modulus: the result takes the modulus' sign.
double pymod(double value, double modulus) {
  const double r = std::fmod(value, modulus);
  return r < 0 ? r + modulus : r;
}

void write(JsonWriter& json, const Vec& v) {
  json.value(v.x);
  json.value(v.y);
  json.value(v.z);
}

struct Ends {
  int a = -1, b = -1;
};

// -- edges: [0, a, b] line; [1, a, b, centre, normal, ref, radius, sweep] arc; [2, a, b, length, middle, polyline]

bool freeForm(GeomAbs_CurveType kind) {
  return kind == GeomAbs_BSplineCurve || kind == GeomAbs_BezierCurve || kind == GeomAbs_OffsetCurve ||
         kind == GeomAbs_OtherCurve;
}

void writeLine(JsonWriter& json, const Ends& ends) {
  json.beginArray();
  json.value(0);
  json.value(ends.a);
  json.value(ends.b);
  json.endArray();
}

struct Arc {
  Vec centre, normal, ref;
  double radius, sweep;
};

void writeArc(JsonWriter& json, const Ends& ends, const Arc& arc) {
  json.beginArray();
  json.value(1);
  json.value(ends.a);
  json.value(ends.b);
  write(json, arc.centre);
  write(json, arc.normal);
  write(json, arc.ref);
  json.value(arc.radius);
  json.value(arc.sweep);
  json.endArray();
}

// A recognised circle comes with an arbitrary frame: orient it so the arc runs from start through middle.
Arc arcThrough(const gp_Circ& circle, const Vec& start, const Vec& middle, const Vec& end) {
  const Vec centre = xyz(circle.Location()), x = xyz(circle.XAxis().Direction());
  const bool closed = dist(start, end) < 1e-6;
  const Vec axis = xyz(circle.Axis().Direction());
  Vec normal, y;
  double first = 0, sweep = 0;
  for (const Vec& candidate : {axis, scale(axis, -1)}) {
    normal = candidate;
    y = cross(normal, x);
    auto angle = [&](const Vec& p) {
      const Vec v = sub(p, centre);
      return std::atan2(dot(v, y), dot(v, x));
    };
    first = angle(start);
    sweep = closed ? kTwoPi : pymod(angle(end) - first, kTwoPi);
    if (closed) break;
    const double along = pymod(angle(middle) - first, kTwoPi);
    if (0 < along && along < sweep) break;
  }
  const Vec ref = add(scale(x, std::cos(first)), scale(y, std::sin(first)));
  return {centre, normal, ref, circle.Radius(), sweep};
}

void writeCurve(JsonWriter& json, const BRepAdaptor_Curve& curve, double u1, double u2, const Ends& ends) {
  const double length = GCPnts_AbscissaPoint::Length(curve);
  const Vec middle = xyz(curve.Value(GCPnts_AbscissaPoint(curve, length / 2, u1).Parameter()));
  const GCPnts_TangentialDeflection polyline(curve, u1, u2, 0.1, kPolylineDeflection);
  json.beginArray();
  json.value(2);
  json.value(ends.a);
  json.value(ends.b);
  json.value(length);
  write(json, middle);
  json.beginArray();
  for (int i = 1; i <= polyline.NbPoints(); ++i) write(json, xyz(polyline.Value(i)));
  json.endArray();
  json.endArray();
}

// The arc as the measurement data can hold it, else what it is at that precision: a line when it is straight
// within the recognition tolerance and both its vertices are known, a curve otherwise.
void writeKept(JsonWriter& json, const Arc& arc, const BRepAdaptor_Curve& curve, double u1, double u2,
               const Ends& ends) {
  if (arc.sweep >= kMinSweep && arc.radius < kMaxRadius) {
    writeArc(json, ends, arc);
    return;
  }
  // The arc's greatest distance from its chord; past half a turn that is the radius and more.
  const double sagitta = arc.radius * (1 - std::cos(std::min(arc.sweep, M_PI) / 2));
  if (sagitta < kRecognitionTolerance && ends.a >= 0 && ends.b >= 0) writeLine(json, ends);
  else writeCurve(json, curve, u1, u2, ends);
}

// The line or circle a free-form edge matches, if any: the candidate with the smallest gap. 0 line, 1 circle,
// -1 neither.
int recogniseCurve(const TopoDS_Edge& edge, gp_Circ& circle) {
  ShapeAnalysis_CanonicalRecognition recognition(edge);
  int best = -1;
  double gap = 0;
  gp_Lin line;
  if (recognition.IsLine(kRecognitionTolerance, line)) {
    best = 0;
    gap = recognition.GetGap();
  }
  recognition.ClearStatus();
  if (recognition.IsCircle(kRecognitionTolerance, circle) && (best < 0 || recognition.GetGap() < gap)) best = 1;
  recognition.ClearStatus();
  return best;
}

Ends edgeEnds(const TopoDS_Edge& edge, const ShapeMap& vertices) {
  return {vertices.FindIndex(TopExp::FirstVertex(edge)) - 1, vertices.FindIndex(TopExp::LastVertex(edge)) - 1};
}

// Writes the edge's record and returns its vertices, a at the curve's first parameter whatever the edge's
// orientation.
Ends writeEdge(JsonWriter& json, const TopoDS_Edge& edge, const ShapeMap& vertices, const std::vector<double>& points) {
  const BRepAdaptor_Curve curve(edge);
  const double u1 = curve.FirstParameter(), u2 = curve.LastParameter();
  const Vec start = xyz(curve.Value(u1)), end = xyz(curve.Value(u2));
  Ends ends = edgeEnds(edge, vertices);
  auto gap = [&](int v, const Vec& p) { return dist({points[3 * v], points[3 * v + 1], points[3 * v + 2]}, p); };
  if (ends.a >= 0 && ends.b >= 0 && ends.a != ends.b &&
      gap(ends.a, start) + gap(ends.b, end) > gap(ends.b, start) + gap(ends.a, end)) {
    std::swap(ends.a, ends.b);
  }
  const bool bothEnds = ends.a >= 0 && ends.b >= 0;
  const GeomAbs_CurveType kind = curve.GetType();
  if (kind == GeomAbs_Line && bothEnds) {
    writeLine(json, ends);
    return ends;
  }
  if (kind == GeomAbs_Circle) {
    const gp_Circ circle = curve.Circle();
    const Vec x = xyz(circle.XAxis().Direction()), y = xyz(circle.YAxis().Direction());
    const Vec ref = add(scale(x, std::cos(u1)), scale(y, std::sin(u1)));
    const Arc arc{xyz(circle.Location()), xyz(circle.Axis().Direction()), ref, circle.Radius(),
                  std::min(u2 - u1, kTwoPi)};
    writeKept(json, arc, curve, u1, u2, ends);
    return ends;
  }
  if (freeForm(kind)) {
    gp_Circ circle;
    const int found = recogniseCurve(edge, circle);
    if (found == 0 && bothEnds) {
      writeLine(json, ends);
      return ends;
    }
    if (found == 1) {
      writeKept(json, arcThrough(circle, start, xyz(curve.Value((u1 + u2) / 2)), end), curve, u1, u2, ends);
      return ends;
    }
  }
  writeCurve(json, curve, u1, u2, ends);
  return ends;
}

// -- faces: [kind, area, loops, ...surface] ------------------------------------------------------------------------

// A point on the face's surface and the normal there pointing out of the material.
void outward(const BRepAdaptor_Surface& surface, const TopoDS_Face& face, Vec& point, Vec& normal) {
  const double u1 = surface.FirstUParameter(), u2 = surface.LastUParameter();
  const double v1 = surface.FirstVParameter(), v2 = surface.LastVParameter();
  gp_Pnt p;
  gp_Vec du, dv, n;
  for (const auto& [fu, fv] : {std::pair{0.5, 0.5}, std::pair{0.3, 0.6}, std::pair{0.7, 0.4}}) {
    surface.D1(u1 + fu * (u2 - u1), v1 + fv * (v2 - v1), p, du, dv);
    n = du.Crossed(dv);
    if (n.Magnitude() > 1e-12) break;
  }
  point = xyz(p);
  normal = unit(xyz(n));
  if (face.Orientation() == TopAbs_REVERSED) normal = scale(normal, -1);
}

// The surface part of a face record: kind and its numbers; kind 5 carries nothing.
struct Surface {
  int kind = 5;
  std::vector<double> numbers;
  void push(const Vec& v) { numbers.insert(numbers.end(), {v.x, v.y, v.z}); }
};

Surface planeRecord(const gp_Pln& plane, const Vec& normal) {
  Vec n = xyz(plane.Axis().Direction());
  if (dot(n, normal) < 0) n = scale(n, -1);
  Surface s{0, {}};
  s.push(n);
  s.numbers.push_back(dot(n, xyz(plane.Location())));
  return s;
}

Surface cylinderRecord(const gp_Cylinder& cylinder, const Vec& origin, double length, const Vec& point,
                       const Vec& normal) {
  const Vec axis = xyz(cylinder.Axis().Direction());
  Surface s{1, {}};
  s.push(origin);
  s.push(axis);
  s.numbers.insert(s.numbers.end(), {length, cylinder.Radius(), sign(dot(normal, radial(point, origin, axis)))});
  return s;
}

Surface coneRecord(const gp_Cone& cone, const Vec& point, const Vec& normal) {
  const Vec apex = xyz(cone.Apex());
  Vec axis = xyz(cone.Axis().Direction());
  if (dot(sub(point, apex), axis) < 0) axis = scale(axis, -1);
  Surface s{2, {}};
  s.push(apex);
  s.push(axis);
  s.numbers.insert(s.numbers.end(), {std::fabs(cone.SemiAngle()), sign(dot(normal, radial(point, apex, axis)))});
  return s;
}

Surface sphereRecord(const gp_Sphere& sphere, const Vec& point, const Vec& normal) {
  const Vec centre = xyz(sphere.Location());
  Surface s{3, {}};
  s.push(centre);
  s.numbers.insert(s.numbers.end(), {sphere.Radius(), sign(dot(normal, sub(point, centre)))});
  return s;
}

Surface torusRecord(const gp_Torus& torus, const Vec& point, const Vec& normal) {
  const Vec centre = xyz(torus.Location()), axis = xyz(torus.Axis().Direction());
  const double major = torus.MajorRadius(), minor = torus.MinorRadius();
  if (major <= minor) return {};
  const Vec spine = add(centre, scale(unit(radial(point, centre, axis)), major));
  Surface s{4, {}};
  s.push(centre);
  s.push(axis);
  s.numbers.insert(s.numbers.end(), {major, minor, sign(dot(normal, sub(point, spine)))});
  return s;
}

// The plane, cylinder, cone or sphere a free-form face matches, if any: the candidate with the smallest gap.
Surface recogniseSurface(const TopoDS_Face& face, const BRepAdaptor_Surface& surface, const Vec& point,
                         const Vec& normal) {
  ShapeAnalysis_CanonicalRecognition recognition(face);
  int best = -1;
  double gap = 0;
  gp_Pln plane;
  gp_Cylinder cylinder;
  gp_Cone cone;
  gp_Sphere sphere;
  auto consider = [&](bool matched, int kind) {
    if (matched && (best < 0 || recognition.GetGap() < gap)) {
      best = kind;
      gap = recognition.GetGap();
    }
    recognition.ClearStatus();
  };
  consider(recognition.IsPlane(kRecognitionTolerance, plane), 0);
  consider(recognition.IsCylinder(kRecognitionTolerance, cylinder), 1);
  consider(recognition.IsCone(kRecognitionTolerance, cone), 2);
  consider(recognition.IsSphere(kRecognitionTolerance, sphere), 3);
  switch (best) {
  case 0: return planeRecord(plane, normal);
  case 1: {
    // The axis extent from points spread over the face's parameter box.
    const Vec axis = xyz(cylinder.Axis().Direction()), base = xyz(cylinder.Axis().Location());
    const double u1 = surface.FirstUParameter(), u2 = surface.LastUParameter();
    const double v1 = surface.FirstVParameter(), v2 = surface.LastVParameter();
    double low = 0, high = 0;
    for (int i = 0; i < 5; ++i) {
      for (int j = 0; j < 5; ++j) {
        const gp_Pnt p = surface.Value(u1 + i / 4.0 * (u2 - u1), v1 + j / 4.0 * (v2 - v1));
        const double height = dot(sub(xyz(p), base), axis);
        if (i == 0 && j == 0) low = high = height;
        low = std::min(low, height);
        high = std::max(high, height);
      }
    }
    return cylinderRecord(cylinder, add(base, scale(axis, low)), high - low, point, normal);
  }
  case 2: return coneRecord(cone, point, normal);
  case 3: return sphereRecord(sphere, point, normal);
  default: return {};
  }
}

Surface surfaceRecord(const TopoDS_Face& face) {
  const BRepAdaptor_Surface surface(face, true);
  Vec point, normal;
  outward(surface, face, point, normal);
  switch (surface.GetType()) {
  case GeomAbs_Plane: return planeRecord(surface.Plane(), normal);
  case GeomAbs_Cylinder: {
    const gp_Cylinder cylinder = surface.Cylinder();
    const Vec axis = xyz(cylinder.Axis().Direction());
    const Vec origin = add(xyz(cylinder.Axis().Location()), scale(axis, surface.FirstVParameter()));
    return cylinderRecord(cylinder, origin, surface.LastVParameter() - surface.FirstVParameter(), point, normal);
  }
  case GeomAbs_Cone: return coneRecord(surface.Cone(), point, normal);
  case GeomAbs_Sphere: return sphereRecord(surface.Sphere(), point, normal);
  case GeomAbs_Torus: return torusRecord(surface.Torus(), point, normal);
  default: return recogniseSurface(face, surface, point, normal);
  }
}

// Splits a wire's edges into chains that share vertices: a cylinder's wire without its seam is two circles.
// Chains come in the order of their first edge, edges in wire order.
std::vector<std::vector<int>> chains(const std::vector<int>& ids, const std::vector<Ends>& ends) {
  std::unordered_map<int, int> parent;
  for (int i : ids) parent[i] = i;
  auto find = [&](int i) {
    while (parent[i] != i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  std::unordered_map<int, int> first;
  for (int i : ids) {
    for (int v : {ends[i].a, ends[i].b}) {
      if (v < 0) continue;
      auto seen = first.find(v);
      if (seen != first.end()) parent[find(i)] = find(seen->second);
      else first.emplace(v, i);
    }
  }
  std::vector<std::vector<int>> groups;
  std::unordered_map<int, size_t> groupOf;
  for (int i : ids) {
    const int root = find(i);
    auto slot = groupOf.find(root);
    if (slot == groupOf.end()) {
      slot = groupOf.emplace(root, groups.size()).first;
      groups.emplace_back();
    }
    groups[slot->second].push_back(i);
  }
  return groups;
}

// Edge ids per loop, outer loop first, without seams.
std::vector<std::vector<int>> loops(const TopoDS_Face& face, const ShapeMap& edges, const std::vector<bool>& hidden,
                                    const std::vector<Ends>& ends) {
  const TopoDS_Wire outer = BRepTools::OuterWire(face);
  std::vector<TopoDS_Shape> wires;
  for (TopExp_Explorer explorer(face, TopAbs_WIRE); explorer.More(); explorer.Next()) wires.push_back(explorer.Current());
  if (!outer.IsNull()) {
    std::stable_sort(wires.begin(), wires.end(), [&](const TopoDS_Shape& a, const TopoDS_Shape& b) {
      return !a.IsSame(outer) < !b.IsSame(outer);
    });
  }
  std::vector<std::vector<int>> result;
  for (const TopoDS_Shape& wire : wires) {
    std::vector<int> ids;
    for (TopExp_Explorer walk(wire, TopAbs_EDGE); walk.More(); walk.Next()) {
      const int i = edges.FindIndex(walk.Current()) - 1;
      if (i >= 0 && !hidden[i] && std::find(ids.begin(), ids.end(), i) == ids.end()) ids.push_back(i);
    }
    for (auto& chain : chains(ids, ends)) result.push_back(std::move(chain));
  }
  return result;
}

// Writes the face's record. False for a face without a surface, which is written as the generic kind.
bool writeFace(JsonWriter& json, const TopoDS_Face& face, const ShapeMap& edges, const std::vector<bool>& hidden,
               const std::vector<Ends>& ends, const std::string& body, int id, Warnings& warnings) {
  double area = 0;
  try {
    GProp_GProps props;
    BRepGProp::SurfaceProperties(face, props);
    area = props.Mass();
  } catch (const Standard_Failure& e) {
    warnings.add(body + ": face " + std::to_string(id) + " has no area: " + e.what());
  }
  std::vector<std::vector<int>> faceLoops;
  try {
    faceLoops = loops(face, edges, hidden, ends);
  } catch (const Standard_Failure& e) {
    warnings.add(body + ": face " + std::to_string(id) + " has no loops: " + e.what());
  }
  // A face can come with triangles alone (AP242 tessellated geometry). An adaptor built on it holds a null
  // surface and its first evaluation traps the module, so such a face never reaches one. Its area above is that
  // of its triangles, which BRepGProp takes when there is no surface.
  const bool described = !BRep_Tool::Surface(face).IsNull();
  Surface surface;
  if (described) {
    try {
      surface = surfaceRecord(face);
    } catch (const Standard_Failure& e) {
      warnings.add(body + ": face " + std::to_string(id) + " kept generic: " + e.what());
    }
  }
  json.beginArray();
  json.value(surface.kind);
  json.value(area);
  json.beginArray();
  for (const auto& loop : faceLoops) {
    json.beginArray();
    for (int i : loop) json.value(i);
    json.endArray();
  }
  json.endArray();
  for (double v : surface.numbers) json.value(v);
  json.endArray();
  return described;
}

} // namespace

void writeGeometry(Solid& solid, int32_t faceLimit, Warnings& warnings, std::string& out) {
  // Before the face limit is applied, so that a call over it reports its start and end like every other (ABI.md).
  Progress progress(Phase::geometry);
  if (faceLimit > 0 && solid.faceMap.Extent() > faceLimit) {
    out += "null";
    return;
  }
  solid.mapEdgesAndVertices();
  const ShapeMap &faces = solid.faceMap, &edges = solid.edgeMap, &vertices = solid.vertexMap;
  JsonWriter json(out);
  json.beginObject();

  json.key("p");
  json.beginArray();
  std::vector<double> points;
  points.reserve(3 * vertices.Extent());
  for (int i = 1; i <= vertices.Extent(); ++i) {
    const gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(vertices.FindKey(i)));
    points.insert(points.end(), {p.X(), p.Y(), p.Z()});
  }
  for (double v : points) json.value(v);
  json.endArray();

  // A seam (where a closed surface meets itself) or a degenerated edge cannot be picked in the viewer.
  std::vector<bool> hidden(edges.Extent(), false);
  for (int i = 1; i <= faces.Extent(); ++i) {
    const TopoDS_Face face = TopoDS::Face(faces.FindKey(i));
    for (TopExp_Explorer explorer(face, TopAbs_EDGE); explorer.More(); explorer.Next()) {
      const TopoDS_Edge edge = TopoDS::Edge(explorer.Current());
      const int index = edges.FindIndex(edge) - 1;
      if (index >= 0 && (BRep_Tool::IsClosed(edge, face) || BRep_Tool::Degenerated(edge))) hidden[index] = true;
    }
  }

  json.key("e");
  json.beginArray();
  std::vector<Ends> ends(edges.Extent());
  const double total = edges.Extent() + faces.Extent();
  std::string record;
  int curveless = 0;
  // The edge records' nulls for non-finite values, which their own writers count and `json` cannot see.
  int edgeNonFinite = 0;
  for (int i = 0; i < edges.Extent(); ++i) {
    progress.report(i, total);
    if (hidden[i]) {
      json.null();
      continue;
    }
    // Each record is built apart, so a failure half-way leaves no trace in the output.
    record.clear();
    JsonWriter one(record);
    try {
      ends[i] = writeEdge(one, TopoDS::Edge(edges.FindKey(i + 1)), vertices, points);
      json.raw(record);
      edgeNonFinite += one.nonFinite();
    } catch (const Standard_Failure& e) {
      // One warning names the first such edge and one more counts the rest, which can be every edge of a body.
      if (curveless++ == 0) warnings.add(solid.body + ": edge " + std::to_string(i) + " has no curve: " + e.what());
      json.null();
      // An edge without a record cannot be picked either, so the loops below leave it out like a seam.
      hidden[i] = true;
    }
  }
  json.endArray();
  if (curveless > 1) warnings.add(solid.body + ": " + std::to_string(curveless - 1) + " more edge(s) have no curve");

  json.key("f");
  json.beginArray();
  int bare = 0;
  for (int i = 0; i < faces.Extent(); ++i) {
    progress.report(edges.Extent() + i, total);
    if (!writeFace(json, TopoDS::Face(faces.FindKey(i + 1)), edges, hidden, ends, solid.body, i, warnings)) ++bare;
  }
  json.endArray();
  json.endObject();
  if (bare) warnings.add(solid.body + ": " + std::to_string(bare) + " face(s) have no surface and are measured on the mesh");
  const int nonFinite = json.nonFinite() + edgeNonFinite;
  if (nonFinite) {
    warnings.add(solid.body + ": " + std::to_string(nonFinite) + " geometry value(s) were not finite, written as null");
  }
}
