const BASICS = `# Basic shapes (append fillColor/strokeColor etc. via styleProps)
rectangle      rounded=0;whiteSpace=wrap;html=1;
rounded rect   rounded=1;whiteSpace=wrap;html=1;
ellipse        ellipse;whiteSpace=wrap;html=1;
circle         ellipse;whiteSpace=wrap;html=1;aspect=fixed;
diamond        rhombus;whiteSpace=wrap;html=1;
database       shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;
cloud          ellipse;shape=cloud;whiteSpace=wrap;html=1;
document       shape=document;whiteSpace=wrap;html=1;boundedLbl=1;
hexagon        shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;fixedSize=1;
parallelogram  shape=parallelogram;perimeter=parallelogramPerimeter;whiteSpace=wrap;html=1;fixedSize=1;
triangle       triangle;whiteSpace=wrap;html=1;
process        shape=process;whiteSpace=wrap;html=1;backgroundOutline=1;
step/chevron   shape=step;perimeter=stepPerimeter;whiteSpace=wrap;html=1;fixedSize=1;
note           shape=note;whiteSpace=wrap;html=1;backgroundOutline=1;size=14;
card           shape=card;whiteSpace=wrap;html=1;
actor (person) shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;
image          shape=image;verticalLabelPosition=bottom;verticalAlign=top;imageAspect=0;aspect=fixed;image=<url>;
Useful keys: shadow=1, dashed=1, strokeWidth=2, opacity=50, arcSize=20, glass=1, sketch=1 (hand-drawn), rotation=90.
Default sizes: boxes 120x60, circles 80x80, actors 30x60, icons 48-78 square.`;

const EDGES = `# Edges
orthogonal (default)  edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;
rounded orthogonal    edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;
straight              endArrow=classic;html=1;
curved                edgeStyle=orthogonalEdgeStyle;curved=1;html=1;
elbow                 edgeStyle=elbowEdgeStyle;elbow=horizontal;html=1;   (elbow=vertical)
entity relation       edgeStyle=entityRelationEdgeStyle;html=1;
Arrowheads: endArrow / startArrow = classic | block | open | none | oval | diamond | diamondThin | dash | cross |
  ERone | ERmandOne | ERmany | ERoneToMany | ERzeroToOne | ERzeroToMany; endFill=0 for hollow; endSize=12.
Line: dashed=1; dashPattern=8 8; strokeWidth=2; flowAnimation=1 (animated); strokeColor=#hex.
Labels on edges: labelBackgroundColor=default (keeps text readable over the line).
Pin connection points (0..1 of the shape box): exitX=1;exitY=0.5;entryX=0;entryY=0.5;
UML: inheritance endArrow=block;endFill=0;endSize=16; realization adds dashed=1;
     composition endArrow=diamondThin;endFill=1;endSize=24; aggregation same with endFill=0;
     dependency endArrow=open;endSize=12;dashed=1;`;

const COLORS = `# draw.io default palette (fillColor / strokeColor), harmonious and print-friendly
blue    #dae8fc / #6c8ebf      green  #d5e8d4 / #82b366      orange #ffe6cc / #d79b00
yellow  #fff2cc / #d6b656      red    #f8cecc / #b85450      purple #e1d5e7 / #9673a6
gray    #f5f5f5 / #666666 (fontColor=#333333)
Strong accents (white text): fillColor=#1ba1e2;strokeColor=#006EAF;fontColor=#ffffff  |  #60a917/#2D7600  |  #e51400/#B20000  |  #fa6800/#C73500  |  #6a00ff/#3700CC
Gradient: gradientColor=#7ea6e0;gradientDirection=north.  Transparent: fillColor=none.
Use one hue per concept (e.g. all data stores green) and keep at most 4-5 hues per diagram.
"default" is a valid colour value meaning the theme colour (works in dark mode).`;

const CONTAINERS = `# Containers & grouping
Prefer the group operation (it computes bounds and re-parents children).
dashed boundary   rounded=1;whiteSpace=wrap;html=1;container=1;collapsible=0;dashed=1;fillColor=none;verticalAlign=top;align=left;spacingLeft=10;fontStyle=1;
swimlane          swimlane;whiteSpace=wrap;html=1;startSize=26;   (horizontal=0 for a vertical title bar / pools)
plain group       group;  (invisible, created by group without label/style)
Children's x/y are RELATIVE to the container's top-left. Container must be large enough to enclose children.
Tables / UML classes / ER entities have stack/table child layouts: find a template with drawio_search_shapes and use insertXml.
Vendor groups (AWS VPC/subnet/region, Azure resource group, ...): search "aws vpc group", "azure subnet" etc.`;

const TEXT = `# Text
free text        text;html=1;align=center;verticalAlign=middle;whiteSpace=wrap;rounded=0;
heading          text;html=1;fontSize=20;fontStyle=1;align=left;verticalAlign=middle;
fontStyle bitmask: 1 bold, 2 italic, 4 underline (e.g. 3 = bold+italic). fontSize=14; fontColor=#hex; fontFamily=Helvetica;
align=left|center|right; verticalAlign=top|middle|bottom; labelPosition/verticalLabelPosition to put labels outside a shape
(e.g. verticalLabelPosition=bottom;verticalAlign=top; for icons). whiteSpace=wrap enables wrapping; html=1 enables <b>, <br>, etc.`;

const TOPICS: Record<string, string> = {
	basics: BASICS,
	edges: EDGES,
	colors: COLORS,
	containers: CONTAINERS,
	text: TEXT,
};

export function getStyleReference(topic: string): string {
	if (topic === "all") {
		return Object.values(TOPICS).join("\n\n");
	}
	return TOPICS[topic] ?? `Unknown topic. Available: ${Object.keys(TOPICS).join(", ")}, all`;
}
