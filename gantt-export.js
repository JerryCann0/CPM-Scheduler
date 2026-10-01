"use strict";

// Render the chart's full layout as standalone SVG, then rasterize locally.
// Native SVG shapes keep the canvas exportable without external dependencies.
async function exportGanttPng(container) {
  const chart = container?.firstElementChild;
  if (!chart?.querySelector(".gantt-row")) {
    throw new Error("Add tasks to the chart before exporting.");
  }
  const origin = chart.getBoundingClientRect();
  const legend = container.nextElementSibling;
  const legendItems = legend?.matches(".gantt-legend")
    ? Array.from(legend.querySelectorAll(".legend-item")) : [];
  const chartHeight = Math.ceil(Math.max(chart.scrollHeight, origin.height));
  const legendWidths = legendItems.map(item => item.getBoundingClientRect().width);
  const legendGap = legendItems.length ? parseFloat(getComputedStyle(legend).gap) || 12 : 0;
  const legendWidth = legendWidths.reduce((sum, width) => sum + width, 0)
    + Math.max(0, legendItems.length - 1) * legendGap;
  const timelineEnd = chart.querySelector(".gantt-time-cell:last-child");
  const width = Math.ceil(timelineEnd.getBoundingClientRect().right - origin.left);
  const height = chartHeight + (legendItems.length ? 32 : 0);
  const scale = 2;
  if (width * scale > 16384 || height * scale > 16384 || width * height * scale * scale > 64000000) {
    throw new Error("This chart is too large to export as one PNG. Reduce the schedule size and try again.");
  }
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  function shape(tag, attributes, parent = svg) {
    const element = document.createElementNS(ns, tag);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
    parent.appendChild(element);
    return element;
  }
  shape("rect", { width, height, fill: "white" });
  const elements = chart.querySelectorAll(".gantt-header, .gantt-label-header, .gantt-time-cell, .gantt-row, .gantt-row-label, .gantt-grid-cell, .gantt-bar");
  elements.forEach((element, index) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const x = box.left - origin.left;
    const y = box.top - origin.top;
    shape("rect", { x, y, width: box.width, height: box.height, fill: style.backgroundColor });
    const edges = {
      Top: [x, y, x + box.width, y],
      Right: [x + box.width, y, x + box.width, y + box.height],
      Bottom: [x, y + box.height, x + box.width, y + box.height],
      Left: [x, y, x, y + box.height]
    };
    Object.entries(edges).forEach(([side, points]) => {
      const thickness = parseFloat(style[`border${side}Width`]);
      if (thickness && style[`border${side}Style`] !== "none") {
        shape("line", { x1: points[0], y1: points[1], x2: points[2], y2: points[3], stroke: style[`border${side}Color`], "stroke-width": thickness });
      }
    });
    if (element.matches(".gantt-label-header, .gantt-time-cell, .gantt-row-label")) {
      const clipId = `export-label-${index}`;
      const clip = shape("clipPath", { id: clipId });
      shape("rect", { x, y, width: box.width - 1, height: box.height }, clip);
      const centered = style.textAlign === "center";
      const text = shape("text", {
        x: centered ? x + box.width / 2 : x + parseFloat(style.paddingLeft),
        y: y + box.height / 2,
        "dominant-baseline": "central",
        "text-anchor": centered ? "middle" : "start",
        "font-family": style.fontFamily,
        "font-size": style.fontSize,
        "font-weight": style.fontWeight,
        fill: style.color,
        "clip-path": `url(#${clipId})`
      });
      text.textContent = element.textContent;
    }
  });
  const arrows = chart.querySelector("svg");
  if (arrows) svg.appendChild(arrows.cloneNode(true));
  if (legendItems.length) {
    // Keep the key horizontal without widening short timelines.
    const legendScale = Math.min(1, (width - 24) / legendWidth);
    const legendGroup = shape("g", {
      transform: `translate(12 ${chartHeight + 16}) scale(${legendScale})`
    });
    let x = 0;
    legendItems.forEach((item, index) => {
      const swatch = item.querySelector(".legend-swatch");
      const swatchStyle = getComputedStyle(swatch);
      const textStyle = getComputedStyle(item);
      const y = 0;
      shape("rect", {
        x, y: y - 4, width: 12, height: 8,
        fill: swatchStyle.backgroundColor,
        stroke: swatchStyle.borderTopColor, "stroke-width": 1
      }, legendGroup);
      shape("text", {
        x: x + 15, y, "dominant-baseline": "central",
        "font-family": textStyle.fontFamily, "font-size": textStyle.fontSize,
        fill: textStyle.color
      }, legendGroup).textContent = item.textContent.trim();
      x += legendWidths[index] + legendGap;
    });
  }
  const source = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("Could not render the chart image."));
      image.src = source;
    });
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("PNG export is unavailable in this browser.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Could not create the PNG. Try a smaller chart.");
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = `${container.id}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
  } finally {
    URL.revokeObjectURL(source);
  }
}

document.addEventListener("click", async event => {
  const button = event.target.closest("[data-gantt-export]");
  if (!button || button.disabled) return;
  button.disabled = true;
  const label = button.textContent;
  button.textContent = "Exporting...";
  try {
    await exportGanttPng(document.getElementById(button.dataset.ganttExport));
  } catch (error) {
    alert(error.message || "Could not export the chart.");
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
});
