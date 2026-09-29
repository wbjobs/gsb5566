const DB_NAME = "config-version-manager";
const DB_VERSION = 1;
const STORE_NAME = "app";
const STATE_KEY = "state";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withStore(mode, callback) {
  return openDatabase().then((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    Promise.resolve(callback(store)).then((result) => {
      transaction.oncomplete = () => {
        database.close();
        resolve(result);
      };
    }).catch((error) => {
      transaction.abort();
      database.close();
      reject(error);
    });
    transaction.onerror = () => {
      database.close();
      reject(transaction.error);
    };
  }));
}

function loadState() {
  return withStore("readonly", (store) => new Promise((resolve, reject) => {
    const request = store.get(STATE_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  }));
}

function saveState(state) {
  return withStore("readwrite", (store) => new Promise((resolve, reject) => {
    const request = store.put(state, STATE_KEY);
    request.onsuccess = () => resolve(state);
    request.onerror = () => reject(request.error);
  }));
}

function clearState() {
  return withStore("readwrite", (store) => new Promise((resolve, reject) => {
    const request = store.delete(STATE_KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  }));
}

window.ConfigDB = { loadState, saveState, clearState };
