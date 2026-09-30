// Builds the Claude Desktop extension: build/remnawave-mcp-<version>.mcpb
// Contents: manifest.json, icon, compiled dist/, production node_modules only.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const stage = join(root, 'build', 'mcpb');
const out = join(root, 'build', `remnawave-mcp-${pkg.version}.mcpb`);
const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: 'inherit', shell: true });

if (!existsSync('dist/index.js')) run('npm run build');
rmSync(join(root, 'build'), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// manifest version always follows package.json
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
manifest.version = pkg.version;
writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));

for (const f of ['dist', 'package.json', 'package-lock.json', 'LICENSE', 'README.md', 'README.en.md', 'icon.png'])
    if (existsSync(f)) cpSync(f, join(stage, f), { recursive: true });

run('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', stage);
// packer is fetched on demand (pinned), so it never lands in node_modules of the project
run(`npx --yes @anthropic-ai/mcpb@2.1.2 pack "${stage}" "${out}"`);
console.log(`\n✔ ${out}`);
