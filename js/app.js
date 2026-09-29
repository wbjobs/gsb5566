const stateApi = window.ConfigState;
const dbApi = window.ConfigDB;

const elements = {
  saveState: document.getElementById("saveState"),
  exportBtn: document.getElementById("exportBtn"),
  importBtn: document.getElementById("importBtn"),
  importFile: document.getElementById("importFile"),
  resetBtn: document.getElementById("resetBtn"),
  versionTree: document.getElementById("versionTree"),
  versionList: document.getElementById("versionList"),
  editorBanner: document.getElementById("editorBanner"),
  mergePanel: document.getElementById("mergePanel"),
  editor: document.getElementById("editor"),
  compareLeft: document.getElementById("compareLeft"),
  compareRight: document.getElementById("compareRight"),
  compareBtn: document.getElementById("compareBtn"),
  diffResult: document.getElementById("diffResult"),
  mergeSource: document.getElementById("mergeSource"),
  mergeBtn: document.getElementById("mergeBtn")
};

let state = null;
let tree = null;
let worker = null;
let workerReady = false;
let saveTimer = 0;
let noticeTimer = 0;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function formatValue(value) {
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value ?? "");
}

function shortId(id) {
  return String(id || "").slice(0, 8);
}

function versions() {
  return Object.values(state.versions).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
}

function activeVersion() {
  return stateApi.getActiveVersion(state);
}

function activeConfig() {
  return stateApi.getWorkingConfig(state);
}

function setNotice(message, kind = "info") {
  if (!message) {
    elements.editorBanner.innerHTML = "";
    return;
  }
  elements.editorBanner.innerHTML = `<div class="notice ${kind}">${escapeHtml(message)}</div>`;
  clearTimeout(noticeTimer);
  if (kind === "success") {
    noticeTimer = setTimeout(() => {
      elements.editorBanner.innerHTML = "";
    }, 3500);
  }
}

function queueSave() {
  clearTimeout(saveTimer);
  elements.saveState.textContent = "正在保存…";
  saveTimer = setTimeout(async () => {
    try {
      await dbApi.saveState(state);
      elements.saveState.textContent = `已保存 ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      elements.saveState.textContent = "保存失败";
      setNotice(`IndexedDB 保存失败：${error.message}`, "error");
    }
  }, 180);
}

function updateState(next, options = {}) {
  state = next;
  if (options.save !== false) queueSave();
  render();
  if (options.notice) setNotice(options.notice, options.kind || "info");
}

function createWorker() {
  if (!window.Worker) return null;
  let instance;
  try {
    instance = new Worker("js/worker.js");
  } catch (_) {
    workerReady = false;
    return null;
  }
  let sequence = 0;
  const pending = new Map();
  const disable = () => {
    workerReady = false;
    pending.forEach((resolver) => resolver.reject(new Error("Worker 不可用")));
    pending.clear();
  };
  instance.onmessage = (event) => {
    const resolver = pending.get(event.data.id);
    if (!resolver) return;
    pending.delete(event.data.id);
    if (event.data.ok) resolver.resolve(event.data.result);
    else resolver.reject(new Error(event.data.error.message));
  };
  instance.onerror = disable;
  instance.onmessageerror = disable;
  return {
    run(message) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        instance.postMessage({ ...message, id });
      });
    }
  };
}

async function workerOrMain(message, fallback) {
  if (!workerReady || !worker) return fallback();
  try {
    return await worker.run(message);
  } catch (_) {
    return fallback();
  }
}

async function init() {
  tree = new window.VersionTreeCanvas(elements.versionTree, {
    onSelect: (versionId) => checkAndCheckout(versionId)
  });
  worker = createWorker();
  workerReady = Boolean(worker);
  try {
    const stored = await dbApi.loadState();
    state = stored ? stateApi.importState(stored) : stateApi.createInitialState();
    const validation = stateApi.validateVersionChain(state);
    if (!validation.ok) throw new Error(validation.errors.join("；"));
    render();
    elements.saveState.textContent = "状态已从 IndexedDB 恢复";
  } catch (error) {
    state = stateApi.createInitialState();
    queueSave();
    render();
    setNotice(`无法读取已保存状态，已创建演示数据：${error.message}`, "error");
  }
  bindEvents();
  window.addEventListener("resize", () => tree.render(state, state.activeVersionId));
  runDiff().catch((error) => setNotice(error.message, "error"));
}

function bindEvents() {
  elements.editor.addEventListener("click", handleEditorClick);
  elements.editor.addEventListener("change", handleEditorChange);
  elements.mergePanel.addEventListener("click", handleMergeClick);
  elements.mergePanel.addEventListener("change", handleMergeChange);
  elements.versionList.addEventListener("click", handleVersionListClick);
  elements.compareBtn.addEventListener("click", runDiff);
  elements.mergeBtn.addEventListener("click", startMerge);
  elements.exportBtn.addEventListener("click", exportState);
  elements.importBtn.addEventListener("click", () => elements.importFile.click());
  elements.importFile.addEventListener("change", importStateFromFile);
  elements.resetBtn.addEventListener("click", resetDemo);
}

function render() {
  const current = activeVersion();
  renderVersionList(current);
  renderSelectors(current);
  renderEditor(current);
  renderMergePanel();
  tree.render(state, state.activeVersionId);
}

function renderVersionList(current) {
  elements.versionList.innerHTML = versions().map((version) => {
    const isActive = version.id === state.activeVersionId;
    const isHead = version.id === state.headId;
    const dirty = stateApi.isConfigDirty(state, version.id);
    const badges = [
      version.id === state.rootId ? `<span class="badge purple">ROOT</span>` : "",
      isHead ? `<span class="badge green">HEAD</span>` : "",
      version.rollbackOf ? `<span class="badge amber">回滚</span>` : "",
      isActive ? `<span class="badge blue">查看中</span>` : "",
      dirty ? `<span class="badge red">未提交</span>` : ""
    ].join("");
    return `
      <article class="version-card ${isActive ? "active" : ""}" data-version-id="${version.id}">
        <div class="version-title">
          <span>${escapeHtml(version.message)}</span>
          <span class="badges">${badges}</span>
        </div>
        <div class="version-meta">${escapeHtml(version.author)} · ${new Date(version.createdAt).toLocaleString()}<br>ID ${shortId(version.id)} · 父版本 ${version.parentIds.map(shortId).join(", ") || "无"}</div>
        <div class="version-actions">
          <button type="button" class="small" data-action="checkout">切换</button>
          <button type="button" class="small" data-action="rollback">回滚到此</button>
          <button type="button" class="small" data-action="compare">作为右侧对比</button>
        </div>
      </article>`;
  }).join("");
}

function renderSelectors(current) {
  const options = versions().map((version) => `<option value="${version.id}" ${version.id === current.id ? "selected" : ""}>${escapeHtml(version.message)} (${shortId(version.id)})</option>`).join("");
  elements.compareLeft.innerHTML = options;
  elements.compareRight.innerHTML = options;
  elements.mergeSource.innerHTML = versions().filter((version) => version.id !== current.id).map((version) => `<option value="${version.id}">${escapeHtml(version.message)} (${shortId(version.id)})</option>`).join("");
  const parent = current.parentIds[0];
  if (parent && state.versions[parent]) elements.compareLeft.value = parent;
  elements.compareRight.value = current.id;
}

function renderEditor(current) {
  if (state.mergeSession) {
    elements.editor.innerHTML = `<div class="notice warn">正在合并中。请先在右侧冲突面板标记所有冲突并提交，或取消合并。</div>`;
    return;
  }
  const config = activeConfig();
  const dirty = stateApi.isConfigDirty(state, current.id);
  elements.editor.innerHTML = `
    <div class="editor-toolbar">
      <div>
        <strong>${escapeHtml(current.message)}</strong>
        <div class="muted">${dirty ? "当前版本有未提交草稿" : "工作区与当前版本一致"}</div>
      </div>
      <div class="inline-form">
        <input id="commitMessage" class="message-input" placeholder="版本说明，例如：调整连接池配置">
        <button type="button" class="primary" data-action="commit" ${dirty ? "" : "disabled"}>提交为新版本</button>
        <button type="button" data-action="discard" ${dirty ? "" : "disabled"}>撤销草稿</button>
      </div>
    </div>
    <div class="editor-toolbar">
      <button type="button" class="primary" data-action="add-group">新增分组</button>
      <label class="checkbox-line"><input id="showDeleted" type="checkbox">显示已删除字段/分组（保留墓碑数据）</label>
    </div>
    ${renderGroups(config)}
  `;
  const showDeleted = document.getElementById("showDeleted");
  showDeleted.checked = true;
  showDeleted.addEventListener("change", () => {
    document.querySelectorAll("[data-deleted='true']").forEach((node) => {
      node.classList.toggle("hidden", !showDeleted.checked);
    });
  });
}

function renderGroups(config) {
  return config.groups.map((group) => `
    <section class="group-card ${group.deleted ? "deleted" : ""}" data-group-id="${group.id}" data-deleted="${group.deleted}">
      <header class="group-head">
        <div class="field grow">
          <label>分组名称</label>
          <input data-field="group-name" value="${escapeHtml(group.name)}">
        </div>
        ${group.deleted ? `<span class="tombstone">分组已删除（数据保留）</span>` : ""}
        <button type="button" class="small danger" data-action="${group.deleted ? "restore-group" : "delete-group"}">${group.deleted ? "恢复分组" : "删除分组"}</button>
      </header>
      <div class="group-body">
        ${group.fields.map((field) => renderField(field)).join("")}
        <div>
          <button type="button" class="small primary" data-action="add-field">新增字段</button>
        </div>
      </div>
    </section>
  `).join("");
}

function renderField(field) {
  const checked = field.value === true || field.value === "true";
  const valueInput = field.type === "boolean"
    ? `<input data-field="field-value" type="checkbox" ${checked ? "checked" : ""}>`
    : field.type === "json"
      ? `<textarea data-field="field-value">${escapeHtml(formatValue(field.value))}</textarea>`
      : `<input data-field="field-value" type="${field.type === "number" ? "number" : "text"}" value="${escapeHtml(formatValue(field.value))}">`;
  return `
    <div class="field-card ${field.deleted ? "deleted" : ""}" data-field-id="${field.id}" data-deleted="${field.deleted}">
      <div class="field">
        <label>字段名</label>
        <input data-field="field-name" value="${escapeHtml(field.name)}">
      </div>
      <div class="field">
        <label>类型</label>
        <select data-field="field-type">
          ${["text", "number", "boolean", "json"].map((type) => `<option value="${type}" ${field.type === type ? "selected" : ""}>${type}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label>值</label>
        ${valueInput}
      </div>
      <button type="button" class="small danger" data-action="${field.deleted ? "restore-field" : "delete-field"}">${field.deleted ? "恢复" : "删除"}</button>
    </div>
  `;
}

function readInput(element) {
  if (element.type === "checkbox") return element.checked;
  if (element.tagName === "SELECT") return element.value;
  return element.value;
}

function handleEditorClick(event) {
  const action = event.target.dataset.action;
  if (!action) return;
  const groupElement = event.target.closest("[data-group-id]");
  const groupId = groupElement?.dataset.groupId;
  const fieldElement = event.target.closest("[data-field-id]");
  const fieldId = fieldElement?.dataset.fieldId;

  try {
    if (action === "add-group") {
      const name = window.prompt("新分组名称", "新分组");
      if (name) updateState(stateApi.addGroup(state, name));
    } else if (action === "delete-group") {
      updateState(stateApi.removeGroup(state, groupId));
    } else if (action === "restore-group") {
      updateState(stateApi.restoreGroup(state, groupId));
    } else if (action === "add-field") {
      const name = window.prompt("新字段名称", "新字段");
      if (name) updateState(stateApi.addField(state, groupId, name, "text", ""));
    } else if (action === "delete-field") {
      updateState(stateApi.removeField(state, groupId, fieldId));
    } else if (action === "restore-field") {
      updateState(stateApi.restoreField(state, groupId, fieldId));
    } else if (action === "discard") {
      updateState(stateApi.discardDraft(state), { notice: "已撤销未提交草稿", kind: "success" });
    } else if (action === "commit") {
      const message = document.getElementById("commitMessage").value.trim();
      const result = stateApi.commitVersion(state, message);
      if (result.error) setNotice(result.error.message, "error");
      else updateState(result.state, { notice: "新版本已提交，版本链已更新", kind: "success" });
    }
  } catch (error) {
    setNotice(error.message, "error");
  }
}

function handleEditorChange(event) {
  const target = event.target;
  const property = target.dataset.field;
  if (!property) return;
  const groupElement = target.closest("[data-group-id]");
  const fieldElement = target.closest("[data-field-id]");
  try {
    if (property === "group-name") {
      updateState(stateApi.updateGroup(state, groupElement.dataset.groupId, { name: target.value }), { save: true });
    } else if (property === "field-name") {
      updateState(stateApi.updateField(state, groupElement.dataset.groupId, fieldElement.dataset.fieldId, { name: target.value }));
    } else if (property === "field-type") {
      const fieldCard = activeConfig().groups.find((group) => group.id === groupElement.dataset.groupId)?.fields.find((field) => field.id === fieldElement.dataset.fieldId);
      updateState(stateApi.updateField(state, groupElement.dataset.groupId, fieldElement.dataset.fieldId, {
        type: target.value,
        value: fieldCard?.value
      }), { notice: `字段类型已转为 ${target.value}，值按安全规则转换`, kind: "info" });
    } else if (property === "field-value") {
      const type = fieldElement.querySelector('[data-field="field-type"]').value;
      let value = readInput(target);
      if (type === "json" && typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch (error) {
          setNotice(`JSON 暂未生效：${error.message}`, "warn");
          return;
        }
      }
      updateState(stateApi.updateField(state, groupElement.dataset.groupId, fieldElement.dataset.fieldId, { value }));
      setNotice("", "info");
    }
  } catch (error) {
    setNotice(error.message, "error");
  }
}

function handleVersionListClick(event) {
  const card = event.target.closest("[data-version-id]");
  if (!card) return;
  const versionId = card.dataset.versionId;
  const action = event.target.dataset.action;
  if (!action) return;
  if (action === "checkout") checkAndCheckout(versionId);
  if (action === "rollback") performRollback(versionId);
  if (action === "compare") {
    elements.compareRight.value = versionId;
    runDiff();
  }
}

function checkAndCheckout(versionId) {
  if (state.mergeSession) {
    setNotice("合并未完成，不能切换版本。", "warn");
    return;
  }
  updateState(stateApi.checkoutVersion(state, versionId), { notice: "已切换查看版本；原版本未提交草稿已保留", kind: "success" });
}

function performRollback(versionId) {
  const target = state.versions[versionId];
  if (!window.confirm(`回滚会基于当前版本新建一个指向「${target.message}」的回滚提交，历史版本不会删除。继续？`)) return;
  const result = stateApi.rollbackVersion(state, versionId);
  if (result.error) setNotice(result.error.message, "error");
  else updateState(result.state, { notice: "回滚提交已创建，未删除任何历史数据", kind: "success" });
}

async function runDiff() {
  const leftId = elements.compareLeft.value;
  const rightId = elements.compareRight.value;
  if (!leftId || !rightId || leftId === rightId) {
    elements.diffResult.innerHTML = `<div class="notice warn">请选择两个不同版本。</div>`;
    return;
  }
  const diff = await workerOrMain({
    type: "diff",
    left: state.versions[leftId].config,
    right: state.versions[rightId].config
  }, () => stateApi.diffConfigs(state.versions[leftId].config, state.versions[rightId].config));
  elements.diffResult.innerHTML = renderDiff(diff, leftId, rightId);
}

function renderDiff(diff, leftId, rightId) {
  if (!diff.groups.length) return `<div class="notice success" style="margin-top:12px">两个版本配置完全一致。</div>`;
  const leftName = state.versions[leftId].message;
  const rightName = state.versions[rightId].message;
  return `
    <div class="notice info" style="margin-top:12px">共 ${diff.changeCount} 处变化。</div>
    ${diff.groups.map((group) => `
      <section class="diff-group">
        <div class="diff-head">${escapeHtml(group.name)} <span class="muted">${escapeHtml(shortId(group.id))}</span></div>
        ${group.changes.map((change) => `<table class="diff-table"><tr><th>分组</th><td class="old">${escapeHtml(leftName)}：${escapeHtml(labelValue(change.left))}</td><td class="new">${escapeHtml(rightName)}：${escapeHtml(labelValue(change.right))}</td></tr></table>`).join("")}
        ${group.fields.map((field) => `
          <table class="diff-table">
            <tr><th>字段</th><td colspan="2"><strong>${escapeHtml(field.name)}</strong> <span class="muted">${escapeHtml(shortId(field.id))}</span></td></tr>
            ${field.changes.map((change) => `
              <tr>
                <th>${diffKindLabel(change.kind)}</th>
                <td class="old change-value">${escapeHtml(labelValue(change.left))}</td>
                <td class="new change-value">${escapeHtml(labelValue(change.right))}</td>
              </tr>
            `).join("")}
          </table>`).join("")}
      </section>
    `).join("")}
  `;
}

function labelValue(value) {
  if (value === undefined || value === null) return "不存在";
  if (typeof value === "object") return JSON.stringify(value);
  if (value === true) return "true / 存在";
  if (value === false) return "false / 删除";
  return String(value);
}

function diffKindLabel(kind) {
  return {
    name: "字段名",
    type: "字段类型",
    value: "字段值",
    deleted: "字段状态",
    existence: "字段存在性"
  }[kind] || kind;
}

async function startMerge() {
  if (!elements.mergeSource.value) return;
  const sourceId = elements.mergeSource.value;
  const result = await workerOrMain({
    type: "merge",
    state,
    sourceVersionId: sourceId,
    targetVersionId: state.activeVersionId
  }, () => stateApi.startMerge(state, sourceId, state.activeVersionId));
  if (result.error) {
    setNotice(result.error.message, "error");
    return;
  }
  if (result.fastForward) {
    updateState(result.state, { notice: "来源版本是当前版本的后继，已快进切换。", kind: "success" });
  } else {
    updateState(result.state, { notice: `已创建三路合并会话，共 ${result.mergeSession.conflicts.length} 个冲突待标记。`, kind: "warn" });
  }
}

function renderMergePanel() {
  const session = state.mergeSession;
  if (!session) {
    elements.mergePanel.innerHTML = "";
    return;
  }
  const source = state.versions[session.sourceVersionId];
  const target = state.versions[session.targetVersionId];
  const base = state.versions[session.baseVersionId];
  elements.mergePanel.innerHTML = `
    <div class="notice warn">
      正在合并 <strong>${escapeHtml(source.message)}</strong> 到 <strong>${escapeHtml(target.message)}</strong>；共同祖先：${escapeHtml(base.message)}。
    </div>
    <div class="row" style="margin-bottom:10px">
      <button type="button" class="primary grow" data-action="commit-merge">提交合并版本</button>
      <button type="button" data-action="cancel-merge">取消</button>
    </div>
    ${session.conflicts.length ? session.conflicts.map(renderConflict).join("") : `<div class="notice success">自动合并无冲突，可以直接提交。</div>`}
  `;
}

function renderConflict(conflict) {
  const title = {
    "group-name": "分组名称冲突",
    "group-deleted": "分组删除冲突",
    "field-name": "字段名称冲突",
    "field-type": "字段类型变化冲突",
    "field-value": "字段值冲突",
    "field-deleted": "字段删除冲突"
  }[conflict.kind] || conflict.kind;
  const options = conflict.kind.endsWith("deleted")
    ? [
      ["source", "采用来源（若其删除则删除）"],
      ["target", "采用目标（若其删除则删除）"],
      ["keep", "保留数据"],
      ["delete", "确认删除"]
    ]
    : conflict.kind === "field-type"
      ? [["source", "来源类型"], ["target", "目标类型"]]
      : [
        ["source", "采用来源"],
        ["target", "采用目标"],
        ["base", "保留共同祖先"],
        ["custom", "自定义"]
      ];
  return `
    <article class="conflict-card" data-conflict-id="${conflict.id}">
      <div class="conflict-title">${title} <span class="muted">${escapeHtml(conflict.path || "")}</span></div>
      <div class="conflict-values">
        <div><strong>祖先</strong><pre>${escapeHtml(labelValue(conflict.base))}</pre></div>
        <div><strong>来源</strong><pre>${escapeHtml(labelValue(conflict.source ?? conflict.sourceDeleted))}</pre></div>
        <div><strong>目标</strong><pre>${escapeHtml(labelValue(conflict.target ?? conflict.targetDeleted))}</pre></div>
      </div>
      <select data-conflict-field="resolution">
        <option value="" ${conflict.resolution ? "" : "selected"} disabled>请选择处理方式</option>
        ${options.map(([value, label]) => `<option value="${value}" ${conflict.resolution === value ? "selected" : ""}>${label}</option>`).join("")}
      </select>
      <input data-conflict-field="custom" class="${conflict.resolution === "custom" ? "" : "hidden"}" placeholder="自定义值" value="${escapeHtml(formatValue(conflict.customValue ?? ""))}">
    </article>
  `;
}

async function handleMergeClick(event) {
  const action = event.target.dataset.action;
  if (action === "cancel-merge") {
    updateState(stateApi.cancelMerge(state), { notice: "已取消合并，工作区恢复到当前版本。", kind: "info" });
  }
  if (action === "commit-merge") {
    const result = stateApi.commitMerge(state, `合并到 ${activeVersion().message}`);
    if (result.error) setNotice(result.error.message, "error");
    else updateState(result.state, { notice: "合并版本已提交，双父版本链已记录。", kind: "success" });
  }
}

async function handleMergeChange(event) {
  const card = event.target.closest("[data-conflict-id]");
  if (!card) return;
  const conflictId = card.dataset.conflictId;
  const resolution = card.querySelector('[data-conflict-field="resolution"]').value;
  const customInput = card.querySelector('[data-conflict-field="custom"]');
  customInput.classList.toggle("hidden", resolution !== "custom");
  let customValue = customInput.value;
  const conflict = state.mergeSession.conflicts.find((item) => item.id === conflictId);
  if (resolution === "custom" && conflict?.kind === "field-value") {
    const field = findConflictField(conflict);
    if (field?.type === "json") {
      try {
        customValue = JSON.parse(customValue);
      } catch (_) {}
    }
  }
  const next = await workerOrMain({
    type: "resolve",
    state,
    conflictId,
    resolution,
    customValue
  }, () => stateApi.resolveMergeConflict(state, conflictId, resolution, customValue));
  updateState(next, { notice: "冲突已标记；所有冲突处理后才能提交合并。", kind: "success" });
}

function findConflictField(conflict) {
  return state.mergeSession.result.groups.find((group) => group.id === conflict.groupId)?.fields.find((field) => field.id === conflict.fieldId) || null;
}

function exportState() {
  const serialized = stateApi.exportState(state);
  const blob = new Blob([serialized], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `config-state-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  URL.revokeObjectURL(url);
  setNotice("状态已导出为 JSON。", "success");
}

async function importStateFromFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const imported = await workerOrMain({ type: "import", input: text }, () => stateApi.importState(text));
    if (!window.confirm("导入会替换当前浏览器中的完整状态。建议先导出备份。继续导入？")) return;
    updateState(imported, { notice: "状态已导入，版本链校验通过。", kind: "success" });
  } catch (error) {
    setNotice(`导入失败：${error.message}`, "error");
  } finally {
    event.target.value = "";
  }
}

async function resetDemo() {
  if (!window.confirm("将清空 IndexedDB 并重新生成演示状态，确定继续？")) return;
  await dbApi.clearState();
  state = stateApi.createInitialState("本地配置");
  await dbApi.saveState(state);
  render();
  setNotice("演示状态已重置。", "success");
}

init();
