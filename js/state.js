const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function stableSerialize(value) {
  return JSON.stringify(value ?? null);
}

function uid(prefix) {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeValue(value, type) {
  const text = value === null || value === undefined ? "" : String(value);
  if (type === "number") {
    const number = Number(text);
    return Number.isFinite(number) ? number : 0;
  }
  if (type === "boolean") {
    if (value === true || value === false) return value;
    return text === "true" || text === "1";
  }
  if (type === "json") {
    try {
      return JSON.parse(text);
    } catch (_) {
      return text;
    }
  }
  return text;
}

function createField(name = "新字段", type = "text", value = "") {
  return {
    id: uid("fld"),
    name,
    type,
    value: type === "json" && typeof value === "string" && value.trim() ? normalizeValue(value, type) : value,
    deleted: false
  };
}

function createGroup(name = "新分组") {
  return { id: uid("grp"), name, fields: [], deleted: false };
}

function normalizeField(field) {
  const type = ["text", "number", "boolean", "json"].includes(field.type) ? field.type : "text";
  return {
    id: String(field.id || uid("fld")),
    name: String(field.name ?? "未命名字段"),
    type,
    value: normalizeValue(field.value, type),
    deleted: Boolean(field.deleted)
  };
}

function normalizeGroup(group) {
  return {
    id: String(group.id || uid("grp")),
    name: String(group.name ?? "未命名分组"),
    deleted: Boolean(group.deleted),
    fields: (Array.isArray(group.fields) ? group.fields : []).map(normalizeField)
  };
}

function normalizeConfig(config) {
  return {
    groups: (Array.isArray(config?.groups) ? config.groups : []).map(normalizeGroup)
  };
}

function createInitialState(label = "本地配置") {
  const now = new Date().toISOString();
  const root = {
    id: uid("ver"),
    parentIds: [],
    message: "初始版本",
    author: label,
    createdAt: now,
    config: normalizeConfig({
      groups: [
        {
          name: "基础设置",
          fields: [
            createField("站点名称", "text", "示例服务"),
            createField("最大连接数", "number", 100),
            createField("启用缓存", "boolean", true)
          ]
        },
        {
          name: "高级设置",
          fields: [createField("功能开关", "json", { beta: false, retries: 3 })]
        }
      ]
    })
  };
  return {
    schema: "config-version-manager/v1",
    label,
    rootId: root.id,
    headId: root.id,
    activeVersionId: root.id,
    versions: { [root.id]: root },
    drafts: {},
    mergeSession: null,
    updatedAt: now
  };
}

function getVersionMap(state) {
  return state.versions || {};
}

function getVersion(state, versionId = state.activeVersionId) {
  return getVersionMap(state)[versionId] || null;
}

function getActiveVersion(state) {
  return getVersion(state, state.activeVersionId) || getVersion(state, state.headId) || getVersion(state, state.rootId);
}

function getDraftConfig(state, versionId = state.activeVersionId) {
  const id = versionId || state.activeVersionId;
  return state.drafts?.[id] ? clone(state.drafts[id]) : clone(getVersion(state, id)?.config || { groups: [] });
}

function getWorkingConfig(state) {
  return state.mergeSession ? clone(state.mergeSession.result.config) : getDraftConfig(state, state.activeVersionId);
}

function isConfigDirty(state, versionId = state.activeVersionId) {
  const id = versionId || state.activeVersionId;
  const draft = state.drafts?.[id];
  if (!draft) return false;
  return stableSerialize(normalizeConfig(draft)) !== stableSerialize(normalizeConfig(getVersion(state, id).config));
}

function getGroup(config, groupId) {
  return config.groups.find((group) => group.id === groupId) || null;
}

function getField(config, groupId, fieldId) {
  return getGroup(config, groupId)?.fields.find((field) => field.id === fieldId) || null;
}

function updateWorkingConfig(state, producer) {
  const next = clone(state);
  if (next.mergeSession) {
    const config = normalizeConfig(clone(next.mergeSession.result.config));
    next.mergeSession.result.config = producer(config) || config;
  } else {
    const id = next.activeVersionId;
    const config = getDraftConfig(next, id);
    next.drafts = next.drafts || {};
    next.drafts[id] = producer(config) || config;
  }
  next.updatedAt = new Date().toISOString();
  return next;
}

function addGroup(state, name) {
  return updateWorkingConfig(state, (config) => {
    config.groups.push(createGroup(name));
  });
}

function updateGroup(state, groupId, patch) {
  return updateWorkingConfig(state, (config) => {
    const group = getGroup(config, groupId);
    if (group) Object.assign(group, { name: String(patch.name ?? group.name), deleted: Boolean(patch.deleted ?? group.deleted) });
  });
}

function removeGroup(state, groupId) {
  return updateGroup(state, groupId, { deleted: true });
}

function restoreGroup(state, groupId) {
  return updateGroup(state, groupId, { deleted: false });
}

function addField(state, groupId, name, type, value) {
  return updateWorkingConfig(state, (config) => {
    const group = getGroup(config, groupId);
    if (group) {
      group.deleted = false;
      group.fields.push(createField(name, type, value));
    }
  });
}

function updateField(state, groupId, fieldId, patch) {
  return updateWorkingConfig(state, (config) => {
    const field = getField(config, groupId, fieldId);
    if (!field) return;
    if (hasOwn(patch, "name")) field.name = String(patch.name);
    if (hasOwn(patch, "deleted")) field.deleted = Boolean(patch.deleted);
    if (hasOwn(patch, "type")) {
      const nextType = ["text", "number", "boolean", "json"].includes(patch.type) ? patch.type : field.type;
      field.value = normalizeValue(hasOwn(patch, "value") ? patch.value : field.value, nextType);
      field.type = nextType;
    } else if (hasOwn(patch, "value")) {
      field.value = normalizeValue(patch.value, field.type);
    }
  });
}

function removeField(state, groupId, fieldId) {
  return updateField(state, groupId, fieldId, { deleted: true });
}

function restoreField(state, groupId, fieldId) {
  return updateField(state, groupId, fieldId, { deleted: false });
}

function allGroups(base, other) {
  const byId = new Map();
  (base?.groups || []).forEach((group) => byId.set(group.id, group));
  (other?.groups || []).forEach((group) => byId.set(group.id, group));
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function allFields(baseGroup, otherGroup) {
  const byId = new Map();
  (baseGroup?.fields || []).forEach((field) => byId.set(field.id, field));
  (otherGroup?.fields || []).forEach((field) => byId.set(field.id, field));
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function fieldKind(field, exists) {
  if (!exists || field?.deleted) return "deleted";
  return "present";
}

function diffConfigs(leftConfig, rightConfig) {
  const left = normalizeConfig(leftConfig);
  const right = normalizeConfig(rightConfig);
  const leftGroups = new Map(left.groups.map((group) => [group.id, group]));
  const rightGroups = new Map(right.groups.map((group) => [group.id, group]));
  const groups = [];

  allGroups(left, right).forEach((groupRef) => {
    const leftGroup = leftGroups.get(groupRef.id) || null;
    const rightGroup = rightGroups.get(groupRef.id) || null;
    const group = {
      id: groupRef.id,
      name: rightGroup?.name ?? leftGroup?.name ?? groupRef.id,
      leftExists: Boolean(leftGroup),
      rightExists: Boolean(rightGroup),
      leftDeleted: Boolean(leftGroup?.deleted),
      rightDeleted: Boolean(rightGroup?.deleted),
      changes: [],
      fields: []
    };
    const leftKind = fieldKind(leftGroup, Boolean(leftGroup));
    const rightKind = fieldKind(rightGroup, Boolean(rightGroup));
    if (leftGroup?.name !== rightGroup?.name && leftGroup && rightGroup) {
      group.changes.push({ type: "group-name", left: leftGroup.name, right: rightGroup.name });
    }
    if (leftKind !== rightKind) {
      group.changes.push({ type: "group-status", left: leftKind, right: rightKind });
    }

    const leftFields = new Map((leftGroup?.fields || []).map((field) => [field.id, field]));
    const rightFields = new Map((rightGroup?.fields || []).map((field) => [field.id, field]));
    allFields(leftGroup, rightGroup).forEach((fieldRef) => {
      const leftField = leftFields.get(fieldRef.id) || null;
      const rightField = rightFields.get(fieldRef.id) || null;
      const entry = {
        id: fieldRef.id,
        name: rightField?.name ?? leftField?.name ?? fieldRef.id,
        leftExists: Boolean(leftField),
        rightExists: Boolean(rightField),
        leftDeleted: Boolean(leftField?.deleted),
        rightDeleted: Boolean(rightField?.deleted),
        changes: []
      };
      if (leftField && rightField) {
        if (leftField.name !== rightField.name) {
          entry.changes.push({ kind: "name", left: leftField.name, right: rightField.name });
        }
        if (leftField.type !== rightField.type) {
          entry.changes.push({ kind: "type", left: leftField.type, right: rightField.type });
        }
        if (stableSerialize(leftField.value) !== stableSerialize(rightField.value)) {
          entry.changes.push({ kind: "value", left: clone(leftField.value), right: clone(rightField.value) });
        }
        if (Boolean(leftField.deleted) !== Boolean(rightField.deleted)) {
          entry.changes.push({
            kind: "deleted",
            left: Boolean(leftField.deleted),
            right: Boolean(rightField.deleted)
          });
        }
      } else {
        entry.changes.push({
          kind: "existence",
          left: leftField ? (leftField.deleted ? "deleted" : "present") : "absent",
          right: rightField ? (rightField.deleted ? "deleted" : "present") : "absent"
        });
      }
      if (entry.changes.length) group.fields.push(entry);
    });

    if (group.changes.length || group.fields.length) groups.push(group);
  });

  return {
    groups,
       changeCount: groups.reduce((count, group) => count + group.changes.length + group.fields.reduce((sum, field) => sum + field.changes.length, 0), 0)
  };
}

function getAncestorIds(state, versionId) {
  const result = new Set();
  const walk = (id) => {
    const version = getVersion(state, id);
    if (!version) return;
    (version.parentIds || []).forEach((parentId) => {
      if (!result.has(parentId)) {
        result.add(parentId);
        walk(parentId);
      }
    });
  };
  walk(versionId);
  return result;
}

function isAncestor(state, ancestorId, descendantId) {
  if (ancestorId === descendantId) return true;
  return getAncestorIds(state, descendantId).has(ancestorId);
}

function findCommonAncestor(state, leftId, rightId) {
  if (leftId === rightId) return leftId;
  const leftAncestors = getAncestorIds(state, leftId);
  const rightAncestors = getAncestorIds(state, rightId);
  let candidates = Array.from(leftAncestors).filter((id) => rightAncestors.has(id));
  if (!candidates.length) {
    return state.rootId && leftAncestors.has(state.rootId) && rightAncestors.has(state.rootId) ? state.rootId : null;
  }
  candidates = candidates.filter((id) => !candidates.some((other) => other !== id && isAncestor(state, other, id)));
  candidates.sort((a, b) => {
    const timeA = Date.parse(getVersion(state, a)?.createdAt || 0);
    const timeB = Date.parse(getVersion(state, b)?.createdAt || 0);
    return timeB - timeA || a.localeCompare(b);
  });
  return candidates[0] || null;
}

function canFastForward(state, sourceId, targetId) {
  return isAncestor(state, targetId, sourceId);
}

function detectMergeConflict(state, sourceId, targetId) {
  if (!getVersion(state, sourceId)) return { ok: false, code: "missing-source", message: "来源版本不存在" };
  if (!getVersion(state, targetId)) return { ok: false, code: "missing-target", message: "目标版本不存在" };
  if (sourceId === targetId) return { ok: false, code: "same-version", message: "不能合并相同版本" };
  if (canFastForward(state, sourceId, targetId)) return { ok: true, fastForward: true };
  if (isAncestor(state, sourceId, targetId)) {
    return { ok: false, code: "already-merged", message: "来源版本已经包含在目标版本中" };
  }
  return { ok: true, fastForward: false, baseVersionId: findCommonAncestor(state, sourceId, targetId) };
}

function mergeProperty(baseValue, sourceValue, targetValue, path) {
  const sourceChanged = stableSerialize(baseValue) !== stableSerialize(sourceValue);
  const targetChanged = stableSerialize(baseValue) !== stableSerialize(targetValue);
  if (!sourceChanged) return { value: clone(targetValue), conflict: null };
  if (!targetChanged) return { value: clone(sourceValue), conflict: null };
  if (stableSerialize(sourceValue) === stableSerialize(targetValue)) {
    return { value: clone(sourceValue), conflict: null };
  }
  return {
    value: clone(targetValue),
    conflict: { path, base: clone(baseValue), source: clone(sourceValue), target: clone(targetValue), resolution: null }
  };
}

function mergeField(baseField, sourceField, targetField, groupId) {
  const id = (targetField || sourceField || baseField).id;
  const absent = { deleted: true };
  const base = baseField || absent;
  const source = sourceField || absent;
  const target = targetField || absent;
  const baseDeleted = !baseField || Boolean(baseField.deleted);
  const sourceDeleted = !sourceField || Boolean(sourceField.deleted);
  const targetDeleted = !targetField || Boolean(targetField.deleted);
  const conflicts = [];

  const sourceEdited = !sourceDeleted && (
    stableSerialize(baseField?.name) !== stableSerialize(sourceField?.name)
    || stableSerialize(baseField?.type) !== stableSerialize(sourceField?.type)
    || stableSerialize(baseField ? normalizeValue(baseField.value, sourceField.type) : null) !== stableSerialize(normalizeValue(sourceField.value, sourceField.type))
  );
  const targetEdited = !targetDeleted && (
    stableSerialize(baseField?.name) !== stableSerialize(targetField?.name)
    || stableSerialize(baseField?.type) !== stableSerialize(targetField?.type)
    || stableSerialize(baseField ? normalizeValue(baseField.value, targetField.type) : null) !== stableSerialize(normalizeValue(targetField.value, targetField.type))
  );
  const sourceStatusChanged = sourceDeleted !== baseDeleted;
  const targetStatusChanged = targetDeleted !== baseDeleted;
  if (sourceDeleted !== targetDeleted && ((sourceDeleted && targetStatusChanged && targetEdited) || (targetDeleted && sourceStatusChanged && sourceEdited))) {
      conflicts.push({
        kind: "field-deleted",
        groupId,
        fieldId: id,
        path: `${groupId}.${id}.deleted`,
        sourceDeleted,
        targetDeleted,
        resolution: null
      });
  }

  if (!sourceField || !targetField) {
    return { field: normalizeField(sourceField || targetField || baseField), conflicts };
  }

  const chosen = normalizeField(targetField || sourceField);
  if (!baseField) {
    if (sourceField.name !== targetField.name) {
      conflicts.push({ kind: "field-name", groupId, fieldId: id, path: `${groupId}.${id}.name`, base: null, source: sourceField.name, target: targetField.name, resolution: null });
    }
    if (sourceField.type !== targetField.type) {
      conflicts.push({ kind: "field-type", groupId, fieldId: id, path: `${groupId}.${id}.type`, base: null, source: sourceField.type, target: targetField.type, resolution: null });
    }
    if (stableSerialize(normalizeValue(sourceField.value, chosen.type)) !== stableSerialize(normalizeValue(targetField.value, chosen.type))) {
      conflicts.push({ kind: "field-value", groupId, fieldId: id, path: `${groupId}.${id}.value`, base: null, source: normalizeValue(sourceField.value, chosen.type), target: normalizeValue(targetField.value, chosen.type), resolution: null });
    }
    chosen.deleted = sourceDeleted && targetDeleted;
    return { field: chosen, conflicts };
  }
  const name = mergeProperty(baseField?.name, sourceField?.name, targetField?.name, `${groupId}.${id}.name`);
  if (name.conflict) conflicts.push({ kind: "field-name", groupId, fieldId: id, ...name.conflict, resolution: null });
  chosen.name = name.value;

  const sourceTypeChanged = baseField?.type !== sourceField.type;
  const targetTypeChanged = baseField?.type !== targetField.type;
  let sourceValue = sourceField?.value;
  let targetValue = targetField?.value;
  if (sourceField.type !== targetField.type && (sourceTypeChanged || targetTypeChanged)) {
    conflicts.push({
      kind: "field-type",
      groupId,
      fieldId: id,
      path: `${groupId}.${id}.type`,
      base: baseField?.type ?? null,
      source: sourceField.type,
      target: targetField.type,
      resolution: null
    });
    chosen.type = targetField.type;
    sourceValue = normalizeValue(sourceValue, targetField.type);
    targetValue = normalizeValue(targetValue, targetField.type);
  } else {
    chosen.type = sourceField.type || targetField.type;
  }

  const value = mergeProperty(baseField ? normalizeValue(baseField.value, chosen.type) : "", normalizeValue(sourceValue, chosen.type), normalizeValue(targetValue, chosen.type), `${groupId}.${id}.value`);
  if (value.conflict) conflicts.push({ kind: "field-value", groupId, fieldId: id, ...value.conflict, resolution: null });
  chosen.value = value.value;
  chosen.deleted = sourceDeleted && targetDeleted ? true : Boolean(sourceDeleted || targetDeleted);
  return { field: chosen, conflicts };
}

function groupContentChanged(baseGroup, otherGroup) {
  if (!baseGroup || !otherGroup) return false;
  const normalize = (group) => ({
    name: group.name,
    fields: (group.fields || [])
      .filter((field) => !field.deleted)
      .map((field) => ({ id: field.id, name: field.name, type: field.type, value: normalizeValue(field.value, field.type) }))
  });
  return stableSerialize(normalize(baseGroup)) !== stableSerialize(normalize(otherGroup));
}

function mergeConfigs(baseConfig = { groups: [] }, sourceConfig = { groups: [] }, targetConfig = { groups: [] }, context = {}) {
  const base = normalizeConfig(baseConfig);
  const source = normalizeConfig(sourceConfig);
  const target = normalizeConfig(targetConfig);
  const conflicts = [];
  const groups = [];
  const groupIds = Array.from(new Set([
    ...base.groups.map((group) => group.id),
    ...source.groups.map((group) => group.id),
    ...target.groups.map((group) => group.id)
  ])).sort();

  groupIds.forEach((groupId) => {
    const baseGroup = base.groups.find((group) => group.id === groupId) || null;
    const sourceGroup = source.groups.find((group) => group.id === groupId) || null;
    const targetGroup = target.groups.find((group) => group.id === groupId) || null;
    const baseDeleted = !baseGroup || Boolean(baseGroup.deleted);
    const sourceDeleted = !sourceGroup || Boolean(sourceGroup.deleted);
    const targetDeleted = !targetGroup || Boolean(targetGroup.deleted);

    if (sourceDeleted && targetDeleted) {
      groups.push(normalizeGroup(targetGroup || sourceGroup || baseGroup));
      groups[groups.length - 1].deleted = true;
      return;
    }

    if (sourceDeleted !== targetDeleted) {
      const otherChanged = sourceDeleted
        ? (!targetDeleted && groupContentChanged(baseGroup, targetGroup))
        : (!sourceDeleted && groupContentChanged(baseGroup, sourceGroup));
      if (otherChanged) {
        conflicts.push({
          kind: "group-deleted",
          groupId,
          fieldId: null,
          path: `${groupId}.deleted`,
          sourceDeleted,
          targetDeleted,
          resolution: null
        });
      } else if (sourceDeleted && !sourceStatusChanged) {
        groups.push(normalizeGroup(targetGroup));
        return;
      } else if (targetDeleted && !targetStatusChanged) {
        groups.push(normalizeGroup(sourceGroup));
        return;
      }
      const fallback = normalizeGroup(targetDeleted ? sourceGroup : targetGroup);
      fallback.deleted = true;
      groups.push(fallback);
      return;
    }

    const merged = normalizeGroup(targetGroup || sourceGroup || baseGroup);
    merged.deleted = false;

    if (baseGroup) {
      const name = mergeProperty(baseGroup.name, sourceGroup.name, targetGroup.name, `${groupId}.name`);
      if (name.conflict) {
        conflicts.push({ kind: "group-name", groupId, fieldId: null, ...name.conflict, resolution: null });
      }
      merged.name = name.value;
    } else if (sourceGroup.name !== targetGroup.name) {
      conflicts.push({
        kind: "group-name",
        groupId,
        fieldId: null,
        path: `${groupId}.name`,
        base: null,
        source: sourceGroup.name,
        target: targetGroup.name,
        resolution: null
      });
      merged.name = targetGroup.name;
    }

    const baseFields = new Map((baseGroup?.fields || []).map((field) => [field.id, field]));
    const sourceFields = new Map((sourceGroup?.fields || []).map((field) => [field.id, field]));
    const targetFields = new Map((targetGroup?.fields || []).map((field) => [field.id, field]));
    const fieldIds = Array.from(new Set([
      ...(baseGroup?.fields || []).map((field) => field.id),
      ...(sourceGroup?.fields || []).map((field) => field.id),
      ...(targetGroup?.fields || []).map((field) => field.id)
    ])).sort();
    merged.fields = fieldIds.map((fieldId) => {
      const mergedField = mergeField(baseFields.get(fieldId), sourceFields.get(fieldId), targetFields.get(fieldId), groupId);
      conflicts.push(...mergedField.conflicts);
      return mergedField.field;
    });
    groups.push(merged);
  });

  groups.sort((a, b) => a.id.localeCompare(b.id));
  return {
    config: { groups },
    conflicts: conflicts.map((conflict, index) => ({
      id: `${context.sourceVersionId || "source"}-${context.targetVersionId || "target"}-${index}`,
      ...conflict
    }))
  };
}

function startMerge(state, sourceVersionId, targetVersionId = state.activeVersionId) {
  const detection = detectMergeConflict(state, sourceVersionId, targetVersionId);
  if (!detection.ok) {
    return { state, error: detection };
  }
  if (isConfigDirty(state, targetVersionId)) {
    return { state, error: { ok: false, code: "dirty-working-copy", message: "目标版本存在未提交修改，请先提交或撤销" } };
  }
  if (detection.fastForward) {
    return { state: checkoutVersion(state, sourceVersionId), fastForward: true };
  }
  const baseVersion = getVersion(state, detection.baseVersionId);
  const sourceVersion = getVersion(state, sourceVersionId);
  const targetVersion = getVersion(state, targetVersionId);
  const merged = mergeConfigs(baseVersion.config, sourceVersion.config, targetVersion.config, {
    baseVersionId: baseVersion.id,
    sourceVersionId,
    targetVersionId
  });
  const next = clone(state);
  next.mergeSession = {
    baseVersionId: baseVersion.id,
    sourceVersionId,
    targetVersionId,
    result: clone(merged.config),
    conflicts: merged.conflicts,
    startedAt: new Date().toISOString()
  };
  next.updatedAt = new Date().toISOString();
  return { state: next, mergeSession: next.mergeSession };
}

function resolveMergeConflict(state, conflictId, resolution, customValue) {
  if (!state.mergeSession) return state;
  const session = clone(state.mergeSession);
  const conflict = session.conflicts.find((item) => item.id === conflictId);
  if (!conflict) return state;
  conflict.resolution = resolution;
  if (resolution === "custom" && conflict.kind !== "group-deleted" && conflict.kind !== "field-deleted" && conflict.kind !== "field-type") {
    conflict.customValue = customValue;
  }

  const baseVersion = getVersion(state, session.baseVersionId);
  const sourceVersion = getVersion(state, session.sourceVersionId);
  const targetVersion = getVersion(state, session.targetVersionId);
  const recomputed = mergeConfigs(baseVersion.config, sourceVersion.config, targetVersion.config, {
    baseVersionId: session.baseVersionId,
    sourceVersionId: session.sourceVersionId,
    targetVersionId: session.targetVersionId
  });
  recomputed.conflicts.forEach((item) => {
    const saved = session.conflicts.find((conf) => conf.id === item.id);
    if (saved) Object.assign(item, saved);
  });
  session.conflicts = recomputed.conflicts;
  session.result = recomputed.config;
  session.conflicts.forEach((item) => {
    if (!item.resolution) return;
    let group = session.result.groups.find((candidate) => candidate.id === item.groupId);

    if (item.kind === "group-deleted") {
      const shouldDelete = item.resolution === "delete"
        || (item.resolution === "source" && item.sourceDeleted)
        || (item.resolution === "target" && item.targetDeleted);
      if (!group && !shouldDelete) {
        const sourceCandidate = sourceVersion.config.groups.find((candidate) => candidate.id === item.groupId);
        const targetCandidate = targetVersion.config.groups.find((candidate) => candidate.id === item.groupId);
        group = normalizeGroup(item.resolution === "source" ? sourceCandidate : targetCandidate || sourceCandidate);
        group.id = item.groupId;
        session.result.groups.push(group);
      }
      if (group) group.deleted = shouldDelete;
      return;
    }

    if (item.kind === "group-name") {
      if (!group) return;
      if (item.resolution === "source") group.name = item.source;
      else if (item.resolution === "target") group.name = item.target;
      else if (item.resolution === "base") group.name = item.base;
      else group.name = item.customValue;
      return;
    }

    if (!group) return;
    const field = group.fields.find((candidate) => candidate.id === item.fieldId);
    if (!field) return;

    if (item.kind === "field-deleted") {
      const shouldDelete = item.resolution === "delete"
        || (item.resolution === "source" && item.sourceDeleted)
        || (item.resolution === "target" && item.targetDeleted);
      field.deleted = shouldDelete;
      return;
    }

    if (item.kind === "field-type") {
      const previousType = field.type;
      field.type = item.resolution === "source" ? item.source : item.target;
      if (previousType !== field.type) {
        const valueConflict = session.conflicts.find((candidate) => candidate.groupId === item.groupId && candidate.fieldId === item.fieldId && candidate.kind === "field-value");
        if (valueConflict?.resolution) {
          const rawValue = valueConflict.resolution === "source"
            ? valueConflict.source
            : valueConflict.resolution === "base"
              ? valueConflict.base
              : valueConflict.resolution === "custom"
                ? valueConflict.customValue
                : valueConflict.target;
          field.value = normalizeValue(rawValue, field.type);
        } else {
          field.value = normalizeValue(field.value, field.type);
        }
      }
      return;
    }

    if (item.kind === "field-name") {
      if (item.resolution === "source") field.name = item.source;
      else if (item.resolution === "target") field.name = item.target;
      else if (item.resolution === "base") field.name = item.base;
      else field.name = item.customValue;
      return;
    }

    if (item.kind === "field-value") {
      const rawValue = item.resolution === "source"
        ? item.source
        : item.resolution === "base"
          ? item.base
          : item.resolution === "custom"
            ? item.customValue
            : item.target;
      field.value = normalizeValue(rawValue, field.type);
    }
  });

  const next = clone(state);
  next.mergeSession = session;
  next.updatedAt = new Date().toISOString();
  return next;
}

function cancelMerge(state) {
  const next = clone(state);
  next.mergeSession = null;
  next.updatedAt = new Date().toISOString();
  return next;
}

function hasUnresolvedConflicts(mergeSession) {
  return Boolean(mergeSession?.conflicts.some((conflict) => !conflict.resolution));
}

function commitVersion(state, message, options = {}) {
  if (state.mergeSession && !options.completingMerge) {
    return { state, error: { code: "merge-open", message: "请先完成或取消合并" } };
  }
  const parentIds = options.parentIds || (state.mergeSession ? [state.mergeSession.sourceVersionId, state.mergeSession.targetVersionId] : [state.activeVersionId]);
  const config = options.config || (state.mergeSession ? state.mergeSession.result : getDraftConfig(state, state.activeVersionId));
  const normalizedConfig = normalizeConfig(config);
  const parentId = parentIds[0];
  const parentConfig = parentId ? getVersion(state, parentId)?.config : null;
  if (parentConfig && stableSerialize(normalizeConfig(parentConfig)) === stableSerialize(normalizedConfig) && !options.allowEmpty && !state.mergeSession) {
    return { state, error: { code: "no-changes", message: "没有可提交的配置变化" } };
  }

  const now = new Date().toISOString();
  const version = {
    id: uid("ver"),
    parentIds: clone(parentIds),
    message: String(message || "未命名版本"),
    author: options.author || state.label || "本地用户",
    createdAt: now,
    config: normalizedConfig
  };
  const next = clone(state);
  next.versions[version.id] = version;
  next.headId = version.id;
  if (options.completingMerge && next.mergeSession) {
    delete next.drafts[next.mergeSession.targetVersionId];
    next.mergeSession = null;
  } else {
    delete next.drafts[next.activeVersionId];
  }
  next.activeVersionId = version.id;
  next.updatedAt = now;
  return { state: next, version };
}

function commitMerge(state, message) {
  if (!state.mergeSession) return { state, error: { code: "no-merge", message: "当前没有进行中的合并" } };
  if (state.mergeSession.conflicts.some((conflict) => !conflict.resolution)) {
    return { state, error: { code: "unresolved-conflicts", message: "仍有合并冲突未标记处理方式" } };
  }
  return commitVersion(state, message || "合并版本", { completingMerge: true });
}

function discardDraft(state, versionId = state.activeVersionId) {
  const next = clone(state);
  delete next.drafts[versionId];
  next.updatedAt = new Date().toISOString();
  return next;
}

function checkoutVersion(state, versionId) {
  const version = getVersion(state, versionId);
  if (!version) return state;
  const next = clone(state);
  next.activeVersionId = versionId;
  next.mergeSession = null;
  next.updatedAt = new Date().toISOString();
  return next;
}

function rollbackVersion(state, versionId, message) {
  const target = getVersion(state, versionId);
  if (!target) return { state, error: { code: "missing-version", message: "回滚目标不存在" } };
  if (isConfigDirty(state, state.activeVersionId)) {
    return { state, error: { code: "dirty-working-copy", message: "当前有未提交修改，请先提交或撤销，避免数据丢失" } };
  }
  const result = commitVersion(state, message || `回滚到 ${target.message}`, {
    config: clone(target.config),
    parentIds: [state.activeVersionId, versionId],
    allowEmpty: true
  });
  if (!result.version) return result;
  result.version.rollbackOf = versionId;
  const next = clone(result.state);
  next.versions[result.version.id] = result.version;
  return { state: next, version: next.versions[result.version.id] };
}

function validateVersionChain(state) {
  const errors = [];
  const versions = getVersionMap(state);
  if (!state.rootId || !versions[state.rootId]) errors.push("根版本缺失");
  if (!state.activeVersionId || !versions[state.activeVersionId]) errors.push("活动版本缺失");
  Object.entries(versions).forEach(([id, version]) => {
    if (!version.id || version.id !== id) errors.push(`版本 ID 不一致：${id}`);
    if (!Array.isArray(version.parentIds)) errors.push(`${id} 缺少父版本数组`);
    version.parentIds.forEach((parentId) => {
      if (!versions[parentId]) errors.push(`${id} 引用了不存在的父版本 ${parentId}`);
      if (parentId === id) errors.push(`${id} 出现自引用`);
      if (isAncestor(state, id, parentId)) errors.push(`${id} 的父链包含环`);
    });
    try {
      normalizeConfig(version.config);
      JSON.stringify(version);
    } catch (_) {
      errors.push(`${id} 不可序列化`);
    }
  });
  return { ok: errors.length === 0, errors };
}

function normalizeState(input) {
  const state = typeof input === "string" ? JSON.parse(input) : clone(input);
  if (!state || state.schema !== "config-version-manager/v1") {
    throw new Error("不支持的状态格式");
  }
  if (!state.versions || typeof state.versions !== "object") throw new Error("缺少 versions 映射");
  Object.values(state.versions).forEach((version) => {
    version.config = normalizeConfig(version.config);
    version.parentIds = Array.isArray(version.parentIds) ? version.parentIds : [];
  });
  if (!state.rootId || !state.versions[state.rootId]) throw new Error("根版本无效");
  if (!state.headId || !state.versions[state.headId]) state.headId = state.rootId;
  if (!state.activeVersionId || !state.versions[state.activeVersionId]) state.activeVersionId = state.headId;
  state.drafts = state.drafts || {};
  Object.keys(state.drafts).forEach((id) => {
    if (!state.versions[id]) delete state.drafts[id];
    else state.drafts[id] = normalizeConfig(state.drafts[id]);
  });
  if (state.mergeSession) state.mergeSession.result = normalizeConfig(state.mergeSession.result);
  const validation = validateVersionChain(state);
  if (!validation.ok) throw new Error(validation.errors.join("；"));
  state.updatedAt = state.updatedAt || new Date().toISOString();
  return state;
}

function exportState(state) {
  const clean = normalizeState(state);
  clean.exportedAt = new Date().toISOString();
  return JSON.stringify(clean, null, 2);
}

function importState(input) {
  return normalizeState(input);
}

const api = {
  addField,
  addGroup,
  allFields,
  allGroups,
  canFastForward,
  cancelMerge,
  checkoutVersion,
  commitMerge,
  commitVersion,
  createField,
  createGroup,
  createInitialState,
  detectMergeConflict,
  diffConfigs,
  discardDraft,
  exportState,
  findCommonAncestor,
  getActiveVersion,
  getAncestorIds,
  getDraftConfig,
  getField,
  getGroup,
  getVersion,
  getWorkingConfig,
  importState,
  isAncestor,
  isConfigDirty,
  mergeConfigs,
  normalizeConfig,
  normalizeField,
  normalizeState,
  normalizeValue,
  removeField,
  removeGroup,
  resolveMergeConflict,
  restoreField,
  restoreGroup,
  rollbackVersion,
  startMerge,
  updateField,
  updateGroup,
  updateWorkingConfig,
  validateVersionChain
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
}

if (typeof window !== "undefined") {
  window.ConfigState = api;
}
