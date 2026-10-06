// Builds Claude Desktop extensions: build/remnawave-<panel minor>.mcpb
//
//   npm run pack:mcpb            → one file for the contract in package.json (e.g. remnawave-3.4.mcpb)
//   npm run pack:mcpb -- --all   → one file per Remnawave 3.x minor version (3.0 … 3.4)
//   node scripts/build-mcpb.mjs --print-targets → JSON list of panel versions (for Docker images)
//
// The code is the same in every file: tools are generated from @remnawave/backend-contract at startup,
// so each file just carries the contract of its panel version.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const stable = pkg.dependencies['@remnawave/backend-contract']; // e.g. 3.4.5 — the current stable panel
const MIN_MAJOR_MINOR = [3, 0]; // oldest supported panel line
const minorOf = (v) => v.split('.').slice(0, 2).join('.');
const run = (cmd, cwd = root, quiet = false) =>
    execSync(cmd, { cwd, stdio: quiet ? 'pipe' : 'inherit', shell: true, encoding: 'utf8' });

/** Contract version per panel minor: latest patch of older minors, the pinned stable one for the current minor. */
function targets(all) {
    if (!all) return [[minorOf(stable), stable]];
    const versions = JSON.parse(run('npm view @remnawave/backend-contract versions --json', root, true));
    const [sMaj, sMin] = stable.split('.').map(Number);
    const byMinor = new Map();
    for (const v of versions) {
        if (!/^\d+\.\d+\.\d+$/.test(v)) continue; // skip pre-releases
        const [maj, min] = v.split('.').map(Number);
        const inRange =
            (maj > MIN_MAJOR_MINOR[0] || (maj === MIN_MAJOR_MINOR[0] && min >= MIN_MAJOR_MINOR[1])) &&
            (maj < sMaj || (maj === sMaj && min < sMin));
        if (inRange) byMinor.set(`${maj}.${min}`, v); // versions are sorted → last one wins
    }
    byMinor.set(minorOf(stable), stable);
    return [...byMinor.entries()];
}

// used by the release workflow to build one Docker image per panel version
if (process.argv.includes('--print-targets')) {
    process.stdout.write(JSON.stringify(targets(true).map(([minor, contract]) => ({ minor, contract, latest: contract === stable }))));
    process.exit(0);
}

if (!existsSync('dist/index.js')) run('npm run build');
rmSync(join(root, 'build'), { recursive: true, force: true });

const built = [];
for (const [minor, contract] of targets(process.argv.includes('--all'))) {
    const stage = join(root, 'build', `stage-${minor}`);
    const out = join(root, 'build', `remnawave-${minor}.mcpb`);
    console.log(`\n=== Remnawave ${minor} (contract ${contract}) ===`);
    mkdirSync(stage, { recursive: true });

    for (const f of ['dist', 'package.json', 'package-lock.json', 'LICENSE', 'README.md', 'README.en.md', 'icon.png'])
        if (existsSync(f)) cpSync(f, join(stage, f), { recursive: true });

    run('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', stage);
    if (contract !== stable)
        run(`npm i @remnawave/backend-contract@${contract} --save-exact --omit=dev --ignore-scripts --no-audit --no-fund`, stage);

    // smoke test: the server starts and builds its tool list from this contract
    const tools = run('node dist/index.js --list-tools', stage, true).trim().split('\n').pop();
    console.log(`tools: ${tools}`);

    const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
    manifest.version = pkg.version;
    manifest.display_name = `Remnawave ${minor}`;
    manifest.description = `For Remnawave panel ${minor}.x. ${manifest.description}`;
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // packer is fetched on demand (pinned), so it never lands in node_modules of the project
    run(`npx --yes @anthropic-ai/mcpb@2.1.2 pack "${stage}" "${out}"`, root, true);
    rmSync(stage, { recursive: true, force: true });
    built.push(`remnawave-${minor}.mcpb  ← panel ${minor}.x (contract ${contract}; ${tools.split(' (')[0]})`);
}
console.log(`\n✔ built:\n  ${built.join('\n  ')}`);
