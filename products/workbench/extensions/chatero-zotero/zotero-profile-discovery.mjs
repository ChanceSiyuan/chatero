import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_PROFILES_INI_BYTES = 128 * 1024;
const MAX_PREFERENCES_BYTES = 1024 * 1024;
const SAFE_VALUE = /^[^\0-\x1f\x7f]{1,1024}$/u;

function inside(base, candidate) {
  const rel = relative(base, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function validatedValue(value, label) {
  if (typeof value !== "string" || !SAFE_VALUE.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

export function parseZoteroProfilesIni(text, { baseDirectory } = {}) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_PROFILES_INI_BYTES) {
    throw new Error("Zotero profiles.ini is too large");
  }
  const base = resolve(validatedValue(baseDirectory, "Zotero profile base directory"));
  const sections = new Map();
  let current = null;
  for (const [index, raw] of text.replace(/^\uFEFF/u, "").split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const section = /^\[([^\]]+)\]$/u.exec(line);
    if (section) {
      const name = validatedValue(section[1], `profiles.ini section at line ${index + 1}`);
      if (sections.has(name)) throw new Error(`profiles.ini has a duplicate section ${name}`);
      current = new Map();
      sections.set(name, current);
      continue;
    }
    const assignment = /^([^=]+)=(.*)$/u.exec(line);
    if (!assignment || !current) throw new Error(`profiles.ini line ${index + 1} is invalid`);
    const key = validatedValue(assignment[1].trim(), `profiles.ini key at line ${index + 1}`);
    const value = validatedValue(assignment[2].trim(), `profiles.ini value at line ${index + 1}`);
    if (current.has(key)) throw new Error(`profiles.ini has a duplicate ${key} key`);
    current.set(key, value);
  }

  const profiles = [];
  for (const [section, values] of sections) {
    if (!/^Profile[0-9]+$/u.test(section)) continue;
    const name = validatedValue(values.get("Name"), `${section} name`);
    const rawPath = validatedValue(values.get("Path"), `${section} path`);
    const relativeFlag = values.get("IsRelative");
    if (!new Set(["0", "1"]).has(relativeFlag)) throw new Error(`${section} IsRelative is invalid`);
    if (values.has("Default") && !new Set(["0", "1"]).has(values.get("Default"))) {
      throw new Error(`${section} Default is invalid`);
    }
    const path = relativeFlag === "1" ? resolve(base, rawPath) : resolve(rawPath);
    if (relativeFlag === "1" && !inside(base, path)) throw new Error(`${section} path escapes the Zotero profile root`);
    if (relativeFlag === "0" && !isAbsolute(rawPath)) throw new Error(`${section} absolute path is invalid`);
    profiles.push(Object.freeze({ default: values.get("Default") === "1", name, path }));
  }
  return profiles;
}

export function parseZoteroDataDirectoryPreference(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_PREFERENCES_BYTES) {
    throw new Error("Zotero prefs.js is too large");
  }
  if (!/^user_pref\("extensions\.zotero\.useDataDir", true\);\s*$/mu.test(text)) return null;
  const matches = [...text.matchAll(/^user_pref\("extensions\.zotero\.dataDir", ("(?:[^"\\]|\\.)*")\);\s*$/gmu)];
  if (matches.length !== 1) throw new Error("Zotero custom data directory preference is ambiguous");
  let value;
  try { value = JSON.parse(matches[0][1]); }
  catch { throw new Error("Zotero custom data directory preference is invalid"); }
  if (typeof value !== "string" || !isAbsolute(value) || !SAFE_VALUE.test(value)) {
    throw new Error("Zotero custom data directory preference must be an absolute path");
  }
  return resolve(value);
}

function profileRoots({ homeDirectory, platform }) {
  const home = resolve(validatedValue(homeDirectory, "home directory"));
  if (platform === "darwin") return [{ dataPath: join(home, "Zotero"), path: join(home, "Library", "Application Support", "Zotero"), source: "Zotero" }];
  if (platform === "linux") return [{ dataPath: join(home, "Zotero"), path: join(home, ".zotero", "zotero"), source: "Zotero" }];
  return [];
}

async function safeDirectory(path) {
  return lstat(path).then(value => value.isDirectory() && !value.isSymbolicLink()).catch(() => false);
}

export async function discoverZoteroProfiles({
  homeDirectory,
  platform = process.platform,
  inspectDirectory = safeDirectory,
  inspectFile = lstat,
  loadFile = readFile,
} = {}) {
  if (typeof inspectDirectory !== "function" || typeof inspectFile !== "function" || typeof loadFile !== "function") {
    throw new TypeError("Zotero profile discovery dependencies are invalid");
  }
  const found = [];
  const seen = new Set();
  for (const root of profileRoots({ homeDirectory, platform })) {
    const ini = join(root.path, "profiles.ini");
    const metadata = await inspectFile(ini).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!metadata) continue;
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_PROFILES_INI_BYTES) {
      throw new Error("Zotero profiles.ini must be a bounded regular file");
    }
    const profiles = parseZoteroProfilesIni(await loadFile(ini, "utf8"), { baseDirectory: root.path });
    for (const profile of profiles) {
      if (seen.has(profile.path) || !await inspectDirectory(profile.path)) continue;
      let dataPath = root.dataPath;
      const prefs = join(profile.path, "prefs.js");
      const prefsMetadata = await inspectFile(prefs).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
      if (prefsMetadata) {
        if (!prefsMetadata.isFile() || prefsMetadata.isSymbolicLink() || prefsMetadata.size > MAX_PREFERENCES_BYTES) {
          throw new Error("Zotero prefs.js must be a bounded regular file");
        }
        dataPath = parseZoteroDataDirectoryPreference(await loadFile(prefs, "utf8")) ?? dataPath;
      }
      seen.add(profile.path);
      found.push(Object.freeze({ ...profile, dataPath, source: root.source }));
    }
  }
  return found.sort((left, right) => Number(right.default) - Number(left.default)
    || Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
}

export async function selectDiscoveredZoteroProfile({ profiles, showQuickPick } = {}) {
  if (!Array.isArray(profiles) || typeof showQuickPick !== "function") {
    throw new TypeError("Zotero profile chooser configuration is invalid");
  }
  const items = profiles.map(profile => Object.freeze({
    description: profile.path,
    detail: `${profile.source} profile${profile.default ? " · default" : ""}`,
    kind: "profile",
    label: `${profile.default ? "$(star-full)" : "$(account)"} ${profile.name}`,
    dataPath: profile.dataPath,
    name: profile.name,
    path: profile.path,
  }));
  items.push(Object.freeze({ kind: "manual", label: "$(folder-opened) Choose another folder…" }));
  const selected = await showQuickPick(items, {
    ignoreFocusOut: true,
    matchOnDescription: true,
    placeHolder: "Chatero reads the selected profile only after Zotero Core starts",
    title: "Choose the Zotero profile for Chatero Core",
  });
  if (!selected) return null;
  return selected.kind === "manual" ? Object.freeze({ kind: "manual" })
    : Object.freeze({ dataPath: selected.dataPath, kind: "profile", name: selected.name, path: selected.path });
}
