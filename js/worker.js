importScripts("./state.js");

function answer(message) {
  try {
    let result;
    switch (message.type) {
      case "diff":
        result = self.ConfigState.diffConfigs(message.left, message.right);
        break;
      case "merge":
        result = self.ConfigState.startMerge(message.state, message.sourceVersionId, message.targetVersionId);
        break;
      case "resolve":
        result = self.ConfigState.resolveMergeConflict(message.state, message.conflictId, message.resolution, message.customValue);
        break;
      case "validate":
        result = self.ConfigState.validateVersionChain(message.state);
        break;
      case "import":
        result = self.ConfigState.importState(message.input);
        break;
      default:
        throw new Error(`未知任务：${message.type}`);
    }
    self.postMessage({ id: message.id, ok: true, result });
  } catch (error) {
    self.postMessage({ id: message.id, ok: false, error: { message: error.message, stack: error.stack } });
  }
}

self.onmessage = (event) => answer(event.data);
