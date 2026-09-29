class VersionTreeCanvas {
  constructor(canvas, handlers = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.handlers = handlers;
    this.state = null;
    this.nodes = [];
    this.edges = [];
    this.nodeById = new Map();
    this.selectedId = null;
    this.hoverId = null;
    this.width = 0;
    this.height = 0;
    this.scale = window.devicePixelRatio || 1;
    this.handleClick = this.handleClick.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleLeave = this.handleLeave.bind(this);
    this.canvas.addEventListener("click", this.handleClick);
    this.canvas.addEventListener("mousemove", this.handleMouseMove);
    this.canvas.addEventListener("mouseleave", this.handleLeave);
  }

  render(state, selectedId) {
    this.state = state;
    this.selectedId = selectedId;
    this.layout();
    this.draw();
  }

  layout() {
    const versions = Object.values(this.state?.versions || {});
    this.nodeById = new Map(versions.map((version) => [version.id, { version, parents: version.parentIds || [], x: 0, y: 0, children: [] }]));
    this.edges = [];
    const indegree = new Map(Array.from(this.nodeById.keys(), (id) => [id, 0]));
    this.nodeById.forEach((node, id) => {
      node.parents.forEach((parentId) => {
        const parent = this.nodeById.get(parentId);
        if (parent) {
          parent.children.push(id);
          indegree.set(id, (indegree.get(id) || 0) + 1);
        }
      });
    });

    const depth = new Map();
    const queue = Array.from(this.nodeById.keys()).filter((id) => (indegree.get(id) || 0) === 0);
    queue.forEach((id) => depth.set(id, 0));
    const seen = new Set(queue);
    while (queue.length) {
      const id = queue.shift();
      const node = this.nodeById.get(id);
      node.children.forEach((childId) => {
        depth.set(childId, Math.max(depth.get(childId) || 0, (depth.get(id) || 0) + 1));
        const remaining = (indegree.get(childId) || 1) - 1;
        indegree.set(childId, remaining);
        if (!remaining && !seen.has(childId)) {
          seen.add(childId);
          queue.push(childId);
        }
      });
    }
    this.nodeById.forEach((node, id) => {
      if (!depth.has(id)) depth.set(id, 0);
    });

    const byDepth = new Map();
    this.nodeById.forEach((node, id) => {
      const level = depth.get(id) || 0;
      if (!byDepth.has(level)) byDepth.set(level, []);
      byDepth.get(level).push(id);
    });
    byDepth.forEach((ids) => {
      ids.sort((a, b) => {
        const timeA = Date.parse(this.nodeById.get(a).version.createdAt || 0);
        const timeB = Date.parse(this.nodeById.get(b).version.createdAt || 0);
        return timeA - timeB || a.localeCompare(b);
      });
      ids.forEach((id, index) => {
        const node = this.nodeById.get(id);
        node.x = 60 + level * 180;
        node.y = 50 + index * 110;
      });
    });

    this.edges = [];
    this.nodeById.forEach((node, id) => {
      node.parents.forEach((parentId) => {
        if (this.nodeById.has(parentId)) this.edges.push({ from: this.nodeById.get(parentId), to: node, parentId, childId: id });
      });
    });
    this.nodes = Array.from(this.nodeById.values());
    this.width = Math.max(this.canvas.parentElement.clientWidth, (Math.max(...Array.from(depth.values()), 0) + 1) * 180 + 100);
    this.height = Math.max(this.canvas.parentElement.clientHeight, Math.max(...Array.from(byDepth.values()).map((ids) => ids.length * 110), 0) + 100);
  }

  draw() {
    const canvasWidth = Math.max(this.width, this.canvas.parentElement.clientWidth);
    const canvasHeight = Math.max(this.height, this.canvas.parentElement.clientHeight);
    this.canvas.width = canvasWidth * this.scale;
    this.canvas.height = canvasHeight * this.scale;
    this.canvas.style.width = `${canvasWidth}px`;
    this.canvas.style.height = `${canvasHeight}px`;
    this.ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    this.ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    this.ctx.fillStyle = "#f8fafc";
    this.ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    this.edges.forEach((edge) => this.drawEdge(edge));
    this.nodes.forEach((node) => this.drawNode(node));
  }

  drawEdge(edge) {
    const fromX = edge.from.x + 150;
    const fromY = edge.from.y;
    const toX = edge.to.x - 12;
    const toY = edge.to.y;
    const midX = (fromX + toX) / 2;
    this.ctx.beginPath();
    this.ctx.moveTo(fromX, fromY);
    this.ctx.bezierCurveTo(midX, fromY, midX, toY, toX, toY);
    this.ctx.strokeStyle = "#94a3b8";
    this.ctx.lineWidth = 2;
    this.ctx.stroke();
    this.ctx.beginPath();
    this.ctx.moveTo(toX, toY);
    this.ctx.lineTo(toX - 8, toY - 5);
    this.ctx.lineTo(toX - 8, toY + 5);
    this.ctx.closePath();
    this.ctx.fillStyle = "#94a3b8";
    this.ctx.fill();
  }

  drawNode(node) {
    const selected = node.version.id === this.selectedId;
    const hovered = node.version.id === this.hoverId;
    const isHead = node.version.id === this.state.headId;
    const isRoot = node.version.id === this.state.rootId;
    this.ctx.beginPath();
    this.roundRect(node.x - 10, node.y - 34, 160, 68, 10);
    this.ctx.fillStyle = selected ? "#dbeafe" : hovered ? "#e0f2fe" : "#ffffff";
    this.ctx.fill();
    this.ctx.lineWidth = selected ? 3 : isHead ? 2 : 1;
    this.ctx.strokeStyle = selected ? "#2563eb" : isHead ? "#16a34a" : "#cbd5e1";
    this.ctx.stroke();

    this.ctx.fillStyle = "#0f172a";
    this.ctx.font = "bold 13px system-ui, sans-serif";
    this.ctx.textAlign = "left";
    this.ctx.fillText(this.truncate(node.version.message || "未命名", 17), node.x, node.y - 11);
    this.ctx.fillStyle = "#64748b";
    this.ctx.font = "11px system-ui, sans-serif";
    this.ctx.fillText(new Date(node.version.createdAt).toLocaleString(), node.x, node.y + 7);
    const badges = [isRoot ? "ROOT" : null, isHead ? "HEAD" : null, node.version.rollbackOf ? "ROLLBACK" : null].filter(Boolean).join(" / ");
    if (badges) {
      this.ctx.fillStyle = "#7c3aed";
      this.ctx.fillText(badges, node.x, node.y + 24);
    }
  }

  roundRect(x, y, width, height, radius) {
    this.ctx.moveTo(x + radius, y);
    this.ctx.lineTo(x + width - radius, y);
    this.ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    this.ctx.lineTo(x + width, y + height - radius);
    this.ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    this.ctx.lineTo(x + radius, y + height);
    this.ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    this.ctx.lineTo(x, y + radius);
    this.ctx.quadraticCurveTo(x, y, x + radius, y);
  }

  truncate(text, length) {
    return text.length > length ? `${text.slice(0, length - 1)}…` : text;
  }

  getNodeAt(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return this.nodes.find((node) => x >= node.x - 10 && x <= node.x + 150 && y >= node.y - 34 && y <= node.y + 34) || null;
  }

  handleClick(event) {
    const node = this.getNodeAt(event.clientX, event.clientY);
    if (node && this.handlers.onSelect) this.handlers.onSelect(node.version.id);
  }

  handleMouseMove(event) {
    const node = this.getNodeAt(event.clientX, event.clientY);
    const nextHover = node?.version.id || null;
    if (nextHover !== this.hoverId) {
      this.hoverId = nextHover;
      this.canvas.style.cursor = node ? "pointer" : "default";
      this.draw();
    }
  }

  handleLeave() {
    this.hoverId = null;
    this.draw();
  }
}

window.VersionTreeCanvas = VersionTreeCanvas;
