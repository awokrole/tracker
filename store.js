import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.DATA_DIR || './data';
const file = path.join(dataDir, 'dashboard.json');

const defaults = {
  config: {
    server: '',
    wipeDate: '',
    battlemetricsServerId: '',
    authToken: ''
  },
  teams: []
};

function ensure() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(defaults, null, 2));
}

export function readStore() {
  ensure();
  try {
    const x = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      config: { ...defaults.config, ...(x.config || {}) },
      teams: Array.isArray(x.teams) ? x.teams : []
    };
  } catch {
    return structuredClone(defaults);
  }
}

export function writeStore(data) {
  ensure();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
