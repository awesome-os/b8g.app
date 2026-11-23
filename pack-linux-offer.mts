import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

type LinuxArch = 'linux-x64' | 'linux-arm64';

interface BinaryCandidate {
  id: string;
  archivePath: string;
  mode: number;
  sourcePaths: readonly string[];
  description: string;
}

interface TarEntry {
  path: string;
  mode: number;
  type: 'file' | 'dir';
  data: Uint8Array;
  mtime: number;
}

interface ManifestFileEntry {
  archivePath: string;
  sourcePath: string;
  kind: 'elf' | 'script' | 'manifest' | 'policy';
  mode: string;
  bytes: number;
  sha256: string;
  elfMachine?: string;
}

interface BundleManifest {
  arch: LinuxArch;
  filename: string;
  path: string;
  bytes: number;
  uncompressedBytes: number;
  sha256: string;
  elfCount: number;
  fileCount: number;
  files: ManifestFileEntry[];
}

interface ReleaseManifest {
  product: string;
  version: string;
  generatedAt: string;
  targets: Record<LinuxArch, BundleManifest>;
  bundles: BundleManifest[];
}

const PRODUCT_NAME = 'b8g-production-rack';
const RELEASE_VERSION = '1.0.0';

const ELF_MACHINE_BY_ARCH: Record<LinuxArch, { code: number; label: string }> = {
  'linux-x64': { code: 0x3e, label: 'EM_X86_64' },
  'linux-arm64': { code: 0xb7, label: 'EM_AARCH64' },
};

const BINARY_CANDIDATES: Record<LinuxArch, readonly BinaryCandidate[]> = {
  'linux-x64': [
    {
      id: 'b8g-shim',
      archivePath: 'bin/b8g-shim',
      mode: 0o755,
      sourcePaths: ['sections/b8g-native-shim/dist/b8g-shim-linux-x64'],
      description: 'B8G Universal Binary Shim (Linux x64 ELF)',
    },
    {
      id: 'sectium-es',
      archivePath: 'bin/sectium-es',
      mode: 0o755,
      sourcePaths: [
        'sections/b8g-es/dist/sectium-es-linux-x64',
        'sections/b8g-es/dist/sectium-es',
      ],
      description: 'Sectium ECMAScript / TypeScript Runtime (Linux x64 ELF)',
    },
    {
      id: 'sectium-jvm',
      archivePath: 'bin/sectium-jvm',
      mode: 0o755,
      sourcePaths: [
        'sections/b8g-jvm/dist/sectium-jvm-linux-x64',
        'sections/b8g-jvm/dist/sectium-jvm',
      ],
      description: 'Sectium JVM / Kotlin AOT Runtime (Linux x64 ELF)',
    },
    {
      id: 'libsectium_display',
      archivePath: 'lib/libsectium_display.so',
      mode: 0o755,
      sourcePaths: [
        'sections/sectium-display/dist/libsectium_display-linux-x64.so',
        'sections/sectium-display/dist/libsectium_display.so',
      ],
      description: 'Sectium Display Appliance Shared Library (Linux x64 ELF)',
    },
    {
      id: 'libsectium_cp',
      archivePath: 'lib/libsectium_cp.so',
      mode: 0o755,
      sourcePaths: [
        'sections/sectium-cloud-control-plane/dist/libsectium_cp-linux-x64.so',
        'sections/sectium-cloud-control-plane/dist/libsectium_cp.so',
      ],
      description: 'Sectium Cloud Control Plane Shared Library (Linux x64 ELF)',
    },
  ],
  'linux-arm64': [
    {
      id: 'b8g-shim',
      archivePath: 'bin/b8g-shim',
      mode: 0o755,
      sourcePaths: ['sections/b8g-native-shim/dist/b8g-shim-linux-arm64'],
      description: 'B8G Universal Binary Shim (Linux arm64 ELF)',
    },
    {
      id: 'sectium-es',
      archivePath: 'bin/sectium-es',
      mode: 0o755,
      sourcePaths: ['sections/b8g-es/dist/sectium-es-linux-arm64'],
      description: 'Sectium ECMAScript / TypeScript Runtime (Linux arm64 ELF)',
    },
    {
      id: 'sectium-jvm',
      archivePath: 'bin/sectium-jvm',
      mode: 0o755,
      sourcePaths: ['sections/b8g-jvm/dist/sectium-jvm-linux-arm64'],
      description: 'Sectium JVM / Kotlin AOT Runtime (Linux arm64 ELF)',
    },
    {
      id: 'libsectium_display',
      archivePath: 'lib/libsectium_display.so',
      mode: 0o755,
      sourcePaths: ['sections/sectium-display/dist/libsectium_display-linux-arm64.so'],
      description: 'Sectium Display Appliance Shared Library (Linux arm64 ELF)',
    },
    {
      id: 'libsectium_cp',
      archivePath: 'lib/libsectium_cp.so',
      mode: 0o755,
      sourcePaths: ['sections/sectium-cloud-control-plane/dist/libsectium_cp-linux-arm64.so'],
      description: 'Sectium Cloud Control Plane Shared Library (Linux arm64 ELF)',
    },
  ],
};

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function isElfForArch(data: Uint8Array, arch: LinuxArch): boolean {
  if (data.byteLength < 20) return false;
  // ELF magic: 0x7f 'E' 'L' 'F'
  if (data[0] !== 0x7f || data[1] !== 0x45 || data[2] !== 0x4c || data[3] !== 0x46) {
    return false;
  }
  const expectedMachine = ELF_MACHINE_BY_ARCH[arch].code;
  // Little-endian e_machine at offset 18 (uint16)
  const eMachine = data[18] | (data[19] << 8);
  return eMachine === expectedMachine;
}

function writeAscii(buf: Uint8Array, offset: number, length: number, value: string): void {
  const encoded = Buffer.from(value, 'utf8');
  const count = Math.min(encoded.length, length);
  buf.set(encoded.subarray(0, count), offset);
}

function writeOctal(buf: Uint8Array, offset: number, length: number, value: number): void {
  const digits = length - 1;
  const octal = Math.max(0, Math.floor(value)).toString(8).padStart(digits, '0');
  writeAscii(buf, offset, digits, octal.slice(-digits));
  buf[offset + digits] = 0;
}

function splitUstarPath(entryPath: string): { name: string; prefix: string } {
  const normalized = entryPath.replace(/^\/+/, '');
  if (Buffer.byteLength(normalized, 'utf8') <= 100) {
    return { name: normalized, prefix: '' };
  }
  const slashIdx = normalized.lastIndexOf('/');
  if (slashIdx > 0) {
    const prefix = normalized.slice(0, slashIdx);
    const name = normalized.slice(slashIdx + 1);
    if (Buffer.byteLength(name, 'utf8') <= 100 && Buffer.byteLength(prefix, 'utf8') <= 155) {
      return { name, prefix };
    }
  }
  throw new Error(`USTAR path too long: ${entryPath}`);
}

function buildUstarHeader(entry: TarEntry): Uint8Array {
  const header = new Uint8Array(512);
  const { name, prefix } = splitUstarPath(entry.path);

  writeAscii(header, 0, 100, name);
  writeOctal(header, 100, 8, entry.mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.type === 'dir' ? 0 : entry.data.byteLength);
  writeOctal(header, 136, 12, entry.mtime);

  // Checksum field filled with ASCII spaces (0x20) during calculation
  header.fill(0x20, 148, 156);

  header[156] = entry.type === 'dir' ? 0x35 : 0x30; // '5' dir, '0' file
  writeAscii(header, 257, 6, 'ustar\0');
  writeAscii(header, 263, 2, '00');
  writeAscii(header, 265, 32, 'root');
  writeAscii(header, 297, 32, 'root');
  writeOctal(header, 329, 8, 0);
  writeOctal(header, 337, 8, 0);
  if (prefix.length > 0) {
    writeAscii(header, 345, 155, prefix);
  }

  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i];
  }
  const chkOctal = checksum.toString(8).padStart(6, '0');
  writeAscii(header, 148, 6, chkOctal);
  header[154] = 0;
  header[155] = 0x20;

  return header;
}

function createPosixTar(entries: readonly TarEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  for (const entry of entries) {
    const header = buildUstarHeader(entry);
    chunks.push(header);
    totalBytes += 512;

    if (entry.type === 'file' && entry.data.byteLength > 0) {
      chunks.push(entry.data);
      totalBytes += entry.data.byteLength;
      const remainder = entry.data.byteLength % 512;
      if (remainder !== 0) {
        const pad = new Uint8Array(512 - remainder);
        chunks.push(pad);
        totalBytes += pad.byteLength;
      }
    }
  }

  // Two 512-byte zero blocks terminate a POSIX USTAR archive
  const trailer = new Uint8Array(1024);
  chunks.push(trailer);
  totalBytes += 1024;

  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function collectDirectoryEntries(filePaths: readonly string[], mtime: number): TarEntry[] {
  const seen = new Set<string>();
  const dirs: TarEntry[] = [];

  for (const filePath of filePaths) {
    const parts = filePath.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dirPath = `${parts.slice(0, i).join('/')}/`;
      if (!seen.has(dirPath)) {
        seen.add(dirPath);
        dirs.push({
          path: dirPath,
          mode: 0o755,
          type: 'dir',
          data: new Uint8Array(0),
          mtime,
        });
      }
    }
  }

  return dirs;
}

function packTarget(
  workspaceRoot: string,
  siteDir: string,
  releasesDir: string,
  arch: LinuxArch,
  generatedAt: string,
  mtime: number,
): BundleManifest {
  const fileEntries: TarEntry[] = [];
  const manifestFiles: ManifestFileEntry[] = [];
  let elfCount = 0;

  for (const candidate of BINARY_CANDIDATES[arch]) {
    let matchedRelPath: string | null = null;
    let matchedData: Uint8Array | null = null;

    for (const relPath of candidate.sourcePaths) {
      const absPath = resolve(workspaceRoot, relPath);
      if (!existsSync(absPath)) continue;
      const data = readFileSync(absPath);
      if (!isElfForArch(data, arch)) continue;
      matchedRelPath = relPath;
      matchedData = data;
      break;
    }

    if (matchedRelPath && matchedData) {
      elfCount += 1;
      fileEntries.push({
        path: candidate.archivePath,
        mode: candidate.mode,
        type: 'file',
        data: matchedData,
        mtime,
      });
      manifestFiles.push({
        archivePath: candidate.archivePath,
        sourcePath: matchedRelPath,
        kind: 'elf',
        mode: candidate.mode.toString(8).padStart(4, '0'),
        bytes: matchedData.byteLength,
        sha256: sha256Hex(matchedData),
        elfMachine: ELF_MACHINE_BY_ARCH[arch].label,
      });
    }
  }

  const installScriptPath = resolve(siteDir, 'install.sh');
  if (existsSync(installScriptPath)) {
    const rawScript = readFileSync(installScriptPath, 'utf8').replace(/\r\n/g, '\n');
    const scriptBytes = Buffer.from(rawScript, 'utf8');
    fileEntries.push({
      path: 'install.sh',
      mode: 0o755,
      type: 'file',
      data: scriptBytes,
      mtime,
    });
    manifestFiles.push({
      archivePath: 'install.sh',
      sourcePath: 'www-public-websites/b8g.app/install.sh',
      kind: 'script',
      mode: '0755',
      bytes: scriptBytes.byteLength,
      sha256: sha256Hex(scriptBytes),
    });
  }

  const leaseDays = 30;
  const expiresAt = new Date(Date.parse(generatedAt) + leaseDays * 24 * 60 * 60 * 1000).toISOString();
  const leasePolicy = {
    product: PRODUCT_NAME,
    version: RELEASE_VERSION,
    leaseType: 'evaluation-renewable',
    leaseDays,
    gracefulRevocation: true,
    onExpiry: 'read-only-block-new-tenants',
    preservesUserData: true,
    issuedAt: generatedAt,
    expiresAt,
    renewalEndpoint: '/api/rack/lease',
    revocationEndpoint: '/api/rack/lease/revoke',
  };
  const leasePolicyBytes = Buffer.from(`${JSON.stringify(leasePolicy, null, 2)}\n`, 'utf8');
  fileEntries.push({
    path: 'lease-policy.json',
    mode: 0o644,
    type: 'file',
    data: leasePolicyBytes,
    mtime,
  });
  manifestFiles.push({
    archivePath: 'lease-policy.json',
    sourcePath: 'generated:lease-policy.json',
    kind: 'policy',
    mode: '0644',
    bytes: leasePolicyBytes.byteLength,
    sha256: sha256Hex(leasePolicyBytes),
  });

  const applianceManifest = {
    product: PRODUCT_NAME,
    version: RELEASE_VERSION,
    arch,
    elfMachine: ELF_MACHINE_BY_ARCH[arch].label,
    generatedAt,
    elfCount,
    leasePolicy: 'lease-policy.json',
    entrypoints: {
      shim: 'bin/b8g-shim',
      esRuntime: 'bin/sectium-es',
      jvmRuntime: 'bin/sectium-jvm',
      displayLib: 'lib/libsectium_display.so',
      controlPlaneLib: 'lib/libsectium_cp.so',
    },
    files: manifestFiles.map((f) => ({
      path: f.archivePath,
      kind: f.kind,
      bytes: f.bytes,
      sha256: f.sha256,
    })),
  };

  const applianceJsonBytes = Buffer.from(`${JSON.stringify(applianceManifest, null, 2)}\n`, 'utf8');
  fileEntries.push({
    path: 'b8g-rack.json',
    mode: 0o644,
    type: 'file',
    data: applianceJsonBytes,
    mtime,
  });
  manifestFiles.push({
    archivePath: 'b8g-rack.json',
    sourcePath: 'generated:b8g-rack.json',
    kind: 'manifest',
    mode: '0644',
    bytes: applianceJsonBytes.byteLength,
    sha256: sha256Hex(applianceJsonBytes),
  });

  const dirEntries = collectDirectoryEntries(
    fileEntries.map((e) => e.path),
    mtime,
  );
  const tarBytes = createPosixTar([...dirEntries, ...fileEntries]);
  const gzBytes = gzipSync(tarBytes, { level: 9 });

  const filename = `${PRODUCT_NAME}-${arch}.tar.gz`;
  const outPath = resolve(releasesDir, filename);
  writeFileSync(outPath, gzBytes);

  return {
    arch,
    filename,
    path: posix.join('releases', filename),
    bytes: gzBytes.byteLength,
    uncompressedBytes: tarBytes.byteLength,
    sha256: sha256Hex(gzBytes),
    elfCount,
    fileCount: manifestFiles.length,
    files: manifestFiles,
  };
}

function main(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const workspaceRoot = resolve(scriptDir, '..', '..');
  const releasesDir = resolve(scriptDir, 'releases');
  mkdirSync(releasesDir, { recursive: true });

  const now = new Date();
  const generatedAt = now.toISOString();
  const mtime = Math.floor(now.getTime() / 1000);

  const x64 = packTarget(workspaceRoot, scriptDir, releasesDir, 'linux-x64', generatedAt, mtime);
  const arm64 = packTarget(workspaceRoot, scriptDir, releasesDir, 'linux-arm64', generatedAt, mtime);

  const manifest: ReleaseManifest = {
    product: PRODUCT_NAME,
    version: RELEASE_VERSION,
    generatedAt,
    targets: {
      'linux-x64': x64,
      'linux-arm64': arm64,
    },
    bundles: [x64, arm64],
  };

  const manifestPath = resolve(releasesDir, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(`[pack-linux-offer] Wrote ${manifestPath}`);
  for (const bundle of manifest.bundles) {
    console.log(
      `[pack-linux-offer] ${bundle.filename}: ${bundle.bytes} B gz (${bundle.uncompressedBytes} B tar), ${bundle.elfCount} ELF binaries, ${bundle.fileCount} files, sha256=${bundle.sha256}`,
    );
  }
}

main();
