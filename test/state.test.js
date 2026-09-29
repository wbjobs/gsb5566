const assert = require("node:assert/strict");
const test = require("node:test");
const {
  addField,
  checkoutVersion,
  commitMerge,
  commitVersion,
  diffConfigs,
  exportState,
  findCommonAncestor,
  importState,
  isAncestor,
  isConfigDirty,
  mergeConfigs,
  normalizeConfig,
  removeField,
  resolveMergeConflict,
  rollbackVersion,
  startMerge,
  updateField,
  validateVersionChain
} = require("../js/state.js");

function stateFromConfig(config) {
  const version = {
    id: "v1",
    parentIds: [],
    message: "root",
    author: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    config: normalizeConfig(config)
  };
  return {
    schema: "config-version-manager/v1",
    label: "test",
    rootId: "v1",
    headId: "v1",
    activeVersionId: "v1",
    versions: { v1: version },
    drafts: {},
    mergeSession: null,
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

test("draft, commit, checkout and version chain", () => {
  let state = stateFromConfig({ groups: [{ id: "g1", name: "G", fields: [{ id: "f1", name: "F", type: "text", value: "a", deleted: false }] }] });
  state = addField(state, "g1", "F2", "number", 2);
  assert.equal(isConfigDirty(state), true);
  const committed = commitVersion(state, "v2");
  assert.equal(committed.error, undefined);
  state = committed.state;
  assert.equal(state.activeVersionId, committed.version.id);
  assert.deepEqual(committed.version.parentIds, ["v1"]);
  state = checkoutVersion(state, "v1");
  assert.equal(state.activeVersionId, "v1");
  assert.equal(isConfigDirty(state), false);
  const branched = commitVersion(updateField(checkoutVersion(committed.state, "v1"), "g1", "f1", { value: "b" }), "v3");
  assert.equal(findCommonAncestor(branched.state, committed.version.id), "v1");
  assert.equal(isAncestor(branched.state, "v1", committed.version.id), true);
  assert.equal(validateVersionChain(branched.state).ok, true);
});

test("rollback creates a new non-destructive version", () => {
  let state = stateFromConfig({ groups: [{ id: "g1", name: "G", fields: [{ id: "f1", name: "F", type: "text", value: "root", deleted: false }] }] });
  const committed = commitVersion(updateField(state, "g1", "f1", { value: "v2" }), "v2");
  state = committed.state;
  const rolled = rollbackVersion(state, "v1", "back");
  assert.equal(rolled.error, undefined);
  assert.equal(rolled.version.config.groups[0].fields[0].value, "root");
  assert.deepEqual(rolled.version.parentIds, [state.activeVersionId, "v1"]);
  assert.ok(rolled.state.versions.v1);
  assert.ok(rolled.state.versions[state.activeVersionId]);
  assert.equal(rolled.version.rollbackOf, "v1");
  assert.equal(rolled.state.versions[rolled.version.id].rollbackOf, "v1");
});

test("diff detects additions, deletion and type changes", () => {
  const left = normalizeConfig({ groups: [{ id: "g1", name: "G", fields: [{ id: "f1", name: "A", type: "text", value: "1", deleted: false }] }] });
  const right = normalizeConfig({
    groups: [{
      id: "g1",
      name: "G2",
      fields: [
        { id: "f1", name: "A", type: "number", value: 1, deleted: false },
        { id: "f2", name: "B", type: "boolean", value: true, deleted: false }
      ]
    }]
  });
  const diff = diffConfigs(left, right);
  const group = diff.groups[0];
  assert.deepEqual(group.changes.map((change) => change.type), ["group-name"]);
  assert.deepEqual(group.fields.map((field) => field.id).sort(), ["f1", "f2"]);
  assert.deepEqual(group.fields.find((field) => field.id === "f1").changes.map((change) => change.kind), ["type", "value"]);

  const deletedState = removeField(stateFromConfig(left), "g1", "f1");
  const deleted = diffConfigs(left, deletedState.drafts.v1);
  assert.equal(deleted.groups[0].fields[0].changes[0].kind, "deleted");
});

test("three-way merge marks conflicting value, deletion and type changes", () => {
  const base = { groups: [{ id: "g1", name: "G", fields: [{ id: "f1", name: "F", type: "text", value: "base", deleted: false }] }] };
  const source = {
    groups: [{
      id: "g1",
      name: "G",
      fields: [
        { id: "f1", name: "F", type: "number", value: 10, deleted: false },
        { id: "f2", name: "Same", type: "text", value: "source", deleted: false }
      ]
    }]
  };
  const target = {
    groups: [{
      id: "g1",
      name: "G",
      fields: [
        { id: "f1", name: "F", type: "text", value: "target", deleted: true },
      ]
    }]
  };
  const merged = mergeConfigs(base, source, target, { sourceVersionId: "s", targetVersionId: "t" });
  const kinds = merged.conflicts.map((conflict) => conflict.kind).sort();
  assert.deepEqual(kinds, ["field-deleted", "field-type", "field-value"]);
  assert.equal(merged.conflicts.every((conflict) => conflict.resolution === null), true);
  assert.equal(merged.config.groups[0].fields[0].deleted, true);
});

test("merge session requires every conflict to be explicitly resolved", () => {
  const baseConfig = { groups: [{ id: "g1", name: "G", fields: [{ id: "f1", name: "F", type: "text", value: "base", deleted: false }] }] };
  let state = stateFromConfig(baseConfig);
  state.versions.source = {
    id: "source",
    parentIds: ["v1"],
    message: "source",
    author: "test",
    createdAt: "2026-01-02T00:00:00.000Z",
    config: normalizeConfig({ groups: [{ id: "g1", name: "G", fields: [{ id: "f1", name: "F", type: "text", value: "source", deleted: false }] }] })
  };
  state.versions.target = {
    id: "target",
    parentIds: ["v1"],
    message: "target",
    author: "test",
    createdAt: "2026-01-03T00:00:00.000Z",
    config: normalizeConfig({ groups: [{ id: "g1", name: "G", fields: [{ id: "f1", name: "F", type: "text", value: "target", deleted: false }] }] })
  };
  state.headId = "target";
  state.activeVersionId = "target";
  const started = startMerge(state, "source", "target");
  assert.equal(started.mergeSession.conflicts.length, 1);
  const blocked = commitMerge(started.state, "merged");
  assert.equal(blocked.error.code, "unresolved-conflicts");
  const resolved = resolveMergeConflict(started.state, started.mergeSession.conflicts[0].id, "source");
  const completed = commitMerge(resolved, "merged");
  assert.equal(completed.version.config.groups[0].fields[0].value, "source");
  assert.deepEqual(completed.version.parentIds, ["source", "target"]);
});

test("state survives JSON serialization and import validation", () => {
  let state = stateFromConfig({ groups: [{ id: "g1", name: "G", fields: [{ id: "f1", name: "F", type: "json", value: { ok: true }, deleted: false }] }] });
  state = updateField(state, "g1", "f1", { type: "number", value: "42" });
  const exported = exportState(state);
  const imported = importState(exported);
  assert.equal(imported.drafts[imported.activeVersionId].groups[0].fields[0].type, "number");
  assert.equal(imported.drafts[imported.activeVersionId].groups[0].fields[0].value, 42);
  assert.equal(validateVersionChain(imported).ok, true);
});

test("group deletion versus edit remains an explicit merge conflict", () => {
  const base = { groups: [{ id: "g1", name: "G", fields: [{ id: "f1", name: "F", type: "text", value: "base", deleted: false }] }] };
  const source = { groups: [{ id: "g1", name: "G", deleted: true, fields: [{ id: "f1", name: "F", type: "text", value: "base", deleted: false }] }] };
  const target = { groups: [{ id: "g1", name: "G", fields: [{ id: "f1", name: "F", type: "text", value: "target", deleted: false }] }] };
  const merged = mergeConfigs(base, source, target, { sourceVersionId: "s", targetVersionId: "t" });
  assert.equal(merged.conflicts.some((conflict) => conflict.kind === "group-deleted"), true);
  assert.equal(merged.config.groups[0].deleted, true);
});

test("same field added independently with different values conflicts", () => {
  const base = { groups: [] };
  const source = { groups: [{ id: "g1", name: "G", fields: [{ id: "f1", name: "F", type: "text", value: "source", deleted: false }] }] };
  const target = { groups: [{ id: "g1", name: "G", fields: [{ id: "f1", name: "F", type: "text", value: "target", deleted: false }] }] };
  const merged = mergeConfigs(base, source, target, { sourceVersionId: "s", targetVersionId: "t" });
  assert.deepEqual(merged.conflicts.map((conflict) => conflict.kind), ["field-value"]);
  assert.equal(merged.config.groups[0].fields[0].value, "target");
});
