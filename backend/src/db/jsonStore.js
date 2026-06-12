import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const EMPTY_DB = {
  version: 1,
  seasons: [],
  worlds: [],
  diggers: [],
  rentalRequests: [],
  fuelGrants: [],
  socialRewardSubmissions: [],
  chainEvents: [],
  agentStats: [],
  economyStats: [],
  jobRuns: [],
};

export class JsonStore {
  constructor(file) {
    this.file = file;
  }

  async read() {
    try {
      const text = await readFile(this.file, 'utf8');
      return normalizeDb(JSON.parse(text));
    } catch (error) {
      if (error.code === 'ENOENT') return structuredClone(EMPTY_DB);
      throw error;
    }
  }

  async write(db) {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(normalizeDb(db), null, 2)}\n`, 'utf8');
    await rename(tmp, this.file);
  }

  async update(mutator) {
    const db = await this.read();
    const result = await mutator(db);
    await this.write(db);
    return result;
  }
}

export function normalizeDb(db) {
  return {
    ...structuredClone(EMPTY_DB),
    ...db,
    seasons: Array.isArray(db?.seasons) ? db.seasons : [],
    worlds: Array.isArray(db?.worlds) ? db.worlds : [],
    diggers: Array.isArray(db?.diggers) ? db.diggers : [],
    rentalRequests: Array.isArray(db?.rentalRequests) ? db.rentalRequests : [],
    fuelGrants: Array.isArray(db?.fuelGrants) ? db.fuelGrants : [],
    socialRewardSubmissions: Array.isArray(db?.socialRewardSubmissions) ? db.socialRewardSubmissions : [],
    chainEvents: Array.isArray(db?.chainEvents) ? db.chainEvents : [],
    agentStats: Array.isArray(db?.agentStats) ? db.agentStats : [],
    economyStats: Array.isArray(db?.economyStats) ? db.economyStats : [],
    jobRuns: Array.isArray(db?.jobRuns) ? db.jobRuns : [],
  };
}
