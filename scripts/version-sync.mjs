import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const packageJsonPath = path.join(root, "package.json");
const cargoTomlPath = path.join(root, "src-tauri", "Cargo.toml");
const tauriConfPath = path.join(root, "src-tauri", "tauri.conf.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readCargoVersion(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const match = content.match(/^version\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error(`Cannot locate version in ${filePath}`);
  }
  return match[1];
}

function writeCargoVersion(filePath, fromVersion, toVersion) {
  const content = fs.readFileSync(filePath, "utf8");
  const next = content.replace(
    new RegExp(`^version\\s*=\\s*"${fromVersion.replaceAll(".", "\\.")}"`, "m"),
    `version = "${toVersion}"`,
  );
  fs.writeFileSync(filePath, next, "utf8");
}

function assertSemverLike(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Unsupported version format: ${version}`);
  }
}

function bumpPatch(version) {
  const [major, minor, patch] = version.split(".").map((v) => Number(v));
  return `${major}.${minor}.${patch + 1}`;
}

function getVersions() {
  const pkg = readJson(packageJsonPath);
  const tauri = readJson(tauriConfPath);
  const cargo = readCargoVersion(cargoTomlPath);
  return {
    packageVersion: pkg.version,
    cargoVersion: cargo,
    tauriVersion: tauri.version,
  };
}

function checkConsistency() {
  const { packageVersion, cargoVersion, tauriVersion } = getVersions();
  const all = [packageVersion, cargoVersion, tauriVersion];
  const same = all.every((v) => v === all[0]);
  if (!same) {
    throw new Error(
      [
        "Version mismatch detected:",
        `  package.json: ${packageVersion}`,
        `  src-tauri/Cargo.toml: ${cargoVersion}`,
        `  src-tauri/tauri.conf.json: ${tauriVersion}`,
      ].join("\n"),
    );
  }
  console.log(`Version is consistent: ${packageVersion}`);
}

function setVersion(nextVersion) {
  assertSemverLike(nextVersion);
  const pkg = readJson(packageJsonPath);
  const tauri = readJson(tauriConfPath);
  const cargoVersion = readCargoVersion(cargoTomlPath);
  const current = pkg.version;

  pkg.version = nextVersion;
  tauri.version = nextVersion;
  writeJson(packageJsonPath, pkg);
  writeJson(tauriConfPath, tauri);
  writeCargoVersion(cargoTomlPath, cargoVersion, nextVersion);
  console.log(`Version updated: ${current} -> ${nextVersion}`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--check")) {
    checkConsistency();
    return;
  }

  if (args.includes("--patch")) {
    const pkg = readJson(packageJsonPath);
    assertSemverLike(pkg.version);
    setVersion(bumpPatch(pkg.version));
    return;
  }

  const versionArg = args[0];
  if (!versionArg) {
    throw new Error("Usage: node scripts/version-sync.mjs --check | --patch | <x.y.z>");
  }
  setVersion(versionArg);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
