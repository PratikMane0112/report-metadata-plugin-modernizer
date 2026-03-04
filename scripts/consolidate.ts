/**
 * consolidate.ts — Pure Node.js data transformation script.
 *
 * Reads raw data from INPUT_DIR (default: .tmp/metadata-plugin-modernizer-main/)
 * and produces structured JSON files in OUTPUT_DIR (default: public/plugin-modernizer-stats/).
 *
 * Environment variables:
 *   OUTPUT_DIR  — output root (default: public/plugin-modernizer-stats)
 *   INPUT_DIR   — input root  (default: .tmp/metadata-plugin-modernizer-main)
 *   BUILD_NUMBER — Jenkins build number (optional, injected by Jenkins)
 *   BUILD_URL    — Jenkins build URL (optional, injected by Jenkins)
 *
 * Outputs:
 *   - summary.json
 *   - manifest.json
 *   - plugin-recipes-index.json
 *   - recipes.json
 *   - recipes/<recipe-name>.json  (validated copies)
 *   - plugins-reports/<plugin-name>/  (selective directory copies)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Environment-aware paths ─────────────────────────────────────────────────
const OUTPUT_BASE = path.resolve(process.env.OUTPUT_DIR ?? 'public/plugin-modernizer-stats');
const INPUT_BASE = path.resolve(process.env.INPUT_DIR ?? '.tmp/metadata-plugin-modernizer-main');

const REPORTS_DIR = path.join(INPUT_BASE, 'reports');
const RECIPES_SRC = path.join(REPORTS_DIR, 'recipes');
const SUMMARY_MD = path.join(REPORTS_DIR, 'summary.md');
const RECIPES_OUT = path.join(OUTPUT_BASE, 'recipes');
const PLUGINS_OUT = path.join(OUTPUT_BASE, 'plugins-reports');

// Directories at INPUT_BASE root that are NOT plugin directories
const EXCLUDED_DIRS = new Set(['.github', 'reports', '.git', 'CustomHistory']);

let errorCount = 0;

// ── Helpers ─────────────────────────────────────────────────────────────────
function log(msg: string): void {
    const ts = new Date().toISOString().replace('T', ' ').substring(11, 19);
    console.log(`[${ts}] ${msg}`);
}

function ensureDir(dirPath: string): void {
    fs.mkdirSync(dirPath, { recursive: true });
}

function warn(msg: string): void {
    console.warn(`[WARN] ${msg}`);
    errorCount++;
}

function copyDirRecursive(src: string, dest: string): void {
    ensureDir(dest);
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

// ── 2.2 Parse summary.md ───────────────────────────────────────────────────
interface FailureByRecipe {
    recipeId: string;
    failures: number;
}

interface SummaryOutput {
    schemaVersion: '1.0';
    generatedAt: string;
    dataSource: string;
    overview: {
        totalPlugins: number;
        totalMigrations: number;
        successfulMigrations: number;
        failedMigrations: number;
        pendingMigrations: number;
        successRate: number;
    };
    pullRequests: {
        totalPRs: number;
        openPRs: number;
        closedPRs: number;
        mergedPRs: number;
        mergeRate: number;
    };
    failuresByRecipe: FailureByRecipe[];
    pluginsWithFailedMigrations: string[];
    metrics: Record<string, unknown>;
    sections: Array<{
        title: string;
        data: Record<string, unknown>[];
    }>;
}

/**
 * Parse a Markdown table into an array of row objects.
 * Handles standard GFM tables with | delimiters.
 */
function parseMarkdownTable(tableLines: string[]): Record<string, string>[] {
    if (tableLines.length < 3) return [];

    const headerLine = tableLines[0];
    // tableLines[1] is the separator line (---|---)
    const headers = headerLine
        .split('|')
        .map(h => h.trim())
        .filter(h => h.length > 0);

    const rows: Record<string, string>[] = [];
    for (let i = 2; i < tableLines.length; i++) {
        const line = tableLines[i].trim();
        if (!line || !line.includes('|')) continue;
        const cells = line
            .split('|')
            .map(c => c.trim())
            .filter(c => c.length > 0);
        const row: Record<string, string> = {};
        for (let j = 0; j < headers.length && j < cells.length; j++) {
            row[headers[j]] = cells[j];
        }
        rows.push(row);
    }
    return rows;
}

/**
 * Extract all tables and their preceding headings from Markdown.
 */
function extractSections(mdContent: string): Array<{ title: string; data: Record<string, unknown>[] }> {
    const lines = mdContent.split('\n');
    const sections: Array<{ title: string; data: Record<string, unknown>[] }> = [];
    let currentTitle = 'Untitled';
    let tableBuffer: string[] = [];
    let inTable = false;

    for (const line of lines) {
        const headingMatch = line.match(/^#{1,4}\s+(.+)/);
        if (headingMatch) {
            // Flush any pending table
            if (inTable && tableBuffer.length > 0) {
                const data = parseMarkdownTable(tableBuffer);
                if (data.length > 0) {
                    sections.push({ title: currentTitle, data });
                }
                tableBuffer = [];
                inTable = false;
            }
            currentTitle = headingMatch[1].trim();
            continue;
        }

        const isTableLine = line.trim().startsWith('|') || (line.trim().includes('|') && line.trim().match(/^\|?\s*-+/));

        if (isTableLine) {
            inTable = true;
            tableBuffer.push(line);
        } else if (inTable) {
            // End of table
            const data = parseMarkdownTable(tableBuffer);
            if (data.length > 0) {
                sections.push({ title: currentTitle, data });
            }
            tableBuffer = [];
            inTable = false;
        }
    }

    // Flush trailing table
    if (inTable && tableBuffer.length > 0) {
        const data = parseMarkdownTable(tableBuffer);
        if (data.length > 0) {
            sections.push({ title: currentTitle, data });
        }
    }

    return sections;
}

function parseSummaryMd(mdContent: string): SummaryOutput {
    const generatedAtMatch = mdContent.match(/Generated on:\s*(.+?)(?:\n|$)/);
    const generatedAt = generatedAtMatch
        ? new Date(generatedAtMatch[1].trim()).toISOString()
        : new Date().toISOString();

    // Overview section — extract key metrics
    const totalMigrationsMatch = mdContent.match(/\*\*Total Migrations\*\*:\s*([\d,]+)/);
    const failedMigrationsMatch = mdContent.match(/\*\*Failed Migrations\*\*:\s*([\d,]+)/);
    const successRateMatch = mdContent.match(/\*\*Success Rate\*\*:\s*([\d.]+)%/);

    const totalMigrations = totalMigrationsMatch ? parseInt(totalMigrationsMatch[1].replace(/,/g, ''), 10) : 0;
    const failedMigrations = failedMigrationsMatch ? parseInt(failedMigrationsMatch[1].replace(/,/g, ''), 10) : 0;
    const successRate = successRateMatch ? parseFloat(successRateMatch[1]) : 0;
    const successfulMigrations = totalMigrations - failedMigrations;

    // Failures by Recipe
    const failuresByRecipe: FailureByRecipe[] = [];
    const recipeFailureRegex = /^-\s+([\w.]+):\s+(\d+)\s+failures?/gm;
    let recipeMatch: RegExpExecArray | null;
    while ((recipeMatch = recipeFailureRegex.exec(mdContent)) !== null) {
        failuresByRecipe.push({
            recipeId: recipeMatch[1],
            failures: parseInt(recipeMatch[2], 10),
        });
    }

    // Plugins with failed migrations
    const pluginsWithFailedMigrations: string[] = [];
    const pluginFailRegex = /^\s*-\s+\[([^\]]+)\]\([^)]+failed_migrations\.csv\)/gm;
    let pluginMatch: RegExpExecArray | null;
    while ((pluginMatch = pluginFailRegex.exec(mdContent)) !== null) {
        pluginsWithFailedMigrations.push(pluginMatch[1]);
    }

    // PR Statistics table
    const totalPRsMatch = mdContent.match(/Total PRs\s*\|\s*(\d+)/);
    const openPRsMatch = mdContent.match(/Open PRs\s*\|\s*(\d+)/);
    const closedPRsMatch = mdContent.match(/Closed PRs\s*\|\s*(\d+)/);
    const mergedPRsMatch = mdContent.match(/Merged PRs\s*\|\s*(\d+)/);

    const totalPRs = totalPRsMatch ? parseInt(totalPRsMatch[1], 10) : 0;
    const openPRs = openPRsMatch ? parseInt(openPRsMatch[1], 10) : 0;
    const closedPRs = closedPRsMatch ? parseInt(closedPRsMatch[1], 10) : 0;
    const mergedPRs = mergedPRsMatch ? parseInt(mergedPRsMatch[1], 10) : 0;
    const mergeRate = totalPRs > 0 ? (mergedPRs / totalPRs) * 100 : 0;

    // Build dynamic metrics from all extracted values
    const metrics: Record<string, unknown> = {
        totalMigrations,
        failedMigrations,
        successfulMigrations,
        successRate,
        totalPRs,
        openPRs,
        closedPRs,
        mergedPRs,
        mergeRate: parseFloat(mergeRate.toFixed(2)),
        failuresByRecipeCount: failuresByRecipe.length,
        pluginsWithFailedMigrationsCount: pluginsWithFailedMigrations.length,
    };

    // Schema drift guard
    const metricKeys = Object.keys(metrics);
    if (metricKeys.length < 3) {
        console.warn(`WARN: summary.md yielded fewer than 3 metrics fields. Upstream format may have changed.`);
        console.warn(`Parsed fields: [${metricKeys.join(', ')}]`);
    }

    // Extract structured sections from tables
    const sections = extractSections(mdContent);

    const parsedFieldCount = [
        totalMigrationsMatch, failedMigrationsMatch, successRateMatch,
        totalPRsMatch, openPRsMatch, closedPRsMatch, mergedPRsMatch,
    ].filter(Boolean).length;

    if (parsedFieldCount < 5) {
        console.warn(`WARN: summary.md may have changed format. Only ${parsedFieldCount}/7 expected fields parsed.`);
    }

    log(`Parsed summary.md: ${parsedFieldCount} fields, ${failuresByRecipe.length} recipe failures, ${pluginsWithFailedMigrations.length} failed plugins, ${sections.length} table sections.`);

    return {
        schemaVersion: '1.0',
        generatedAt,
        dataSource: 'https://github.com/jenkins-infra/metadata-plugin-modernizer',
        overview: {
            totalPlugins: 0, // Will be set after plugin enumeration
            totalMigrations,
            successfulMigrations,
            failedMigrations,
            pendingMigrations: 0,
            successRate,
        },
        pullRequests: {
            totalPRs,
            openPRs,
            closedPRs,
            mergedPRs,
            mergeRate: parseFloat(mergeRate.toFixed(2)),
        },
        failuresByRecipe,
        pluginsWithFailedMigrations,
        metrics,
        sections,
    };
}

// ── 2.3 Copy recipes ───────────────────────────────────────────────────────
function copyRecipes(): string[] {
    ensureDir(RECIPES_OUT);
    const recipeNames: string[] = [];

    if (!fs.existsSync(RECIPES_SRC)) {
        warn('reports/recipes/ directory not found.');
        return recipeNames;
    }

    const files = fs.readdirSync(RECIPES_SRC);
    for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const srcPath = path.join(RECIPES_SRC, file);
        const destPath = path.join(RECIPES_OUT, file);
        try {
            const content = fs.readFileSync(srcPath, 'utf-8');
            JSON.parse(content); // validate JSON
            fs.writeFileSync(destPath, content, 'utf-8');
            recipeNames.push(file.replace(/\.json$/, ''));
        } catch (err) {
            warn(`Skipping malformed recipe file: ${file} — ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    recipeNames.sort();
    log(`Copied ${recipeNames.length} recipe files.`);
    return recipeNames;
}

// ── 2.4 Copy plugin directories ────────────────────────────────────────────
function copyPlugins(): string[] {
    ensureDir(PLUGINS_OUT);
    const pluginNames: string[] = [];

    const entries = fs.readdirSync(INPUT_BASE, { withFileTypes: true });
    const pluginEntries = entries.filter(e => e.isDirectory() && !EXCLUDED_DIRS.has(e.name));
    const total = pluginEntries.length;

    for (let i = 0; i < pluginEntries.length; i++) {
        const entry = pluginEntries[i];
        const srcPath = path.join(INPUT_BASE, entry.name);
        const destBase = path.join(PLUGINS_OUT, entry.name);

        try {
            // Copy reports/ subdirectory (required for aggregated_migrations.json)
            const reportsDir = path.join(srcPath, 'reports');
            if (fs.existsSync(reportsDir)) {
                copyDirRecursive(reportsDir, path.join(destBase, 'reports'));
            }

            // Copy modernization-metadata/ if it exists
            const metadataDir = path.join(srcPath, 'modernization-metadata');
            if (fs.existsSync(metadataDir)) {
                copyDirRecursive(metadataDir, path.join(destBase, 'modernization-metadata'));
            }

            // Copy failed-migrations.csv if it exists
            const failedCsv = path.join(srcPath, 'failed-migrations.csv');
            if (fs.existsSync(failedCsv)) {
                ensureDir(destBase);
                fs.copyFileSync(failedCsv, path.join(destBase, 'failed-migrations.csv'));
            }

            pluginNames.push(entry.name);
        } catch (err) {
            warn(`Failed to copy plugin directory ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Progress logging every 50 plugins
        if ((i + 1) % 50 === 0) {
            log(`Processed ${i + 1}/${total} plugins...`);
        }
    }

    pluginNames.sort();
    log(`Copied ${pluginNames.length} plugin directories.`);
    return pluginNames;
}

// ── 2.5 Generate plugin-recipes-index.json ─────────────────────────────────
interface PluginRecipesIndex {
    schemaVersion: '1.0';
    generatedAt: string;
    plugins: string[];
    recipes: string[];
}

function writeIndex(plugins: string[], recipes: string[], generatedAt: string): void {
    const index: PluginRecipesIndex = {
        schemaVersion: '1.0',
        generatedAt,
        plugins,
        recipes,
    };
    const outPath = path.join(OUTPUT_BASE, 'plugin-recipes-index.json');
    fs.writeFileSync(outPath, JSON.stringify(index, null, 2), 'utf-8');
    log(`Wrote plugin-recipes-index.json (${plugins.length} plugins, ${recipes.length} recipes).`);
}

// ── 2.6 Generate recipes.json (combined index) ────────────────────────────
interface RecipeIndexEntry {
    recipeId: string;
    totalPlugins: number;
    successCount: number;
    failureCount: number;
}

interface RecipesJsonFull {
    schemaVersion: '1.0';
    generatedAt: string;
    recipes: Record<string, unknown>;
}

interface RecipesJsonMinimal {
    schemaVersion: '1.0';
    generatedAt: string;
    recipes: Record<string, RecipeIndexEntry>;
}

function writeRecipesJson(recipeNames: string[], generatedAt: string): void {
    const recipeFiles = recipeNames.map(name => path.join(RECIPES_OUT, `${name}.json`));
    const totalRecipeBytes = recipeFiles.reduce((sum, f) => {
        try { return sum + fs.statSync(f).size; } catch { return sum; }
    }, 0);

    const MAX_SIZE = 4 * 1024 * 1024; // 4MB

    if (totalRecipeBytes > MAX_SIZE) {
        log(`WARN: Full recipes.json would exceed 4MB (${(totalRecipeBytes / 1024 / 1024).toFixed(1)}MB). Writing minimal index instead.`);
        const minimalRecipes: Record<string, RecipeIndexEntry> = {};
        for (const name of recipeNames) {
            const filePath = path.join(RECIPES_OUT, `${name}.json`);
            try {
                const raw = fs.readFileSync(filePath, 'utf-8');
                const data = JSON.parse(raw) as {
                    recipeId?: string;
                    totalApplications?: number;
                    successCount?: number;
                    failureCount?: number;
                };
                minimalRecipes[name] = {
                    recipeId: data.recipeId ?? name,
                    totalPlugins: data.totalApplications ?? 0,
                    successCount: data.successCount ?? 0,
                    failureCount: data.failureCount ?? 0,
                };
            } catch {
                warn(`Could not read recipe for minimal index: ${name}`);
            }
        }
        const output: RecipesJsonMinimal = {
            schemaVersion: '1.0',
            generatedAt,
            recipes: minimalRecipes,
        };
        fs.writeFileSync(path.join(OUTPUT_BASE, 'recipes.json'), JSON.stringify(output, null, 2), 'utf-8');
    } else {
        const fullRecipes: Record<string, unknown> = {};
        for (const name of recipeNames) {
            const filePath = path.join(RECIPES_OUT, `${name}.json`);
            try {
                const raw = fs.readFileSync(filePath, 'utf-8');
                fullRecipes[name] = JSON.parse(raw);
            } catch {
                warn(`Could not read recipe for full index: ${name}`);
            }
        }
        const output: RecipesJsonFull = {
            schemaVersion: '1.0',
            generatedAt,
            recipes: fullRecipes,
        };
        fs.writeFileSync(path.join(OUTPUT_BASE, 'recipes.json'), JSON.stringify(output, null, 2), 'utf-8');
    }
    log(`Wrote recipes.json (${recipeNames.length} recipes, ${(totalRecipeBytes / 1024).toFixed(0)}KB total).`);
}

// ── 2.7 Generate manifest.json ─────────────────────────────────────────────
interface Manifest {
    schemaVersion: '1.0';
    generatedAt: string;
    pluginCount: number;
    recipeCount: number;
    dataSource: string;
    pipelineRunId?: string;
    pipelineUrl?: string;
}

function writeManifest(pluginCount: number, recipeCount: number, generatedAt: string): void {
    const manifest: Manifest = {
        schemaVersion: '1.0',
        generatedAt,
        pluginCount,
        recipeCount,
        dataSource: 'https://github.com/jenkins-infra/metadata-plugin-modernizer',
    };

    // Include Jenkins build metadata when available
    if (process.env.BUILD_NUMBER) {
        manifest.pipelineRunId = process.env.BUILD_NUMBER;
    }
    if (process.env.BUILD_URL) {
        manifest.pipelineUrl = process.env.BUILD_URL;
    }

    const outPath = path.join(OUTPUT_BASE, 'manifest.json');
    fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2), 'utf-8');
    log(`Wrote manifest.json (${pluginCount} plugins, ${recipeCount} recipes).`);
}

// ── Build recipe stats from output files ────────────────────────────────────
interface RecipeStats {
    recipeId: string;
    total: number;
    success: number;
    fail: number;
    pending: number;
}

function buildRecipeStatsFromFiles(recipeNames: string[]): RecipeStats[] {
    const stats: RecipeStats[] = [];
    for (const name of recipeNames) {
        const filePath = path.join(RECIPES_OUT, `${name}.json`);
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(raw) as {
                recipeId?: string;
                totalApplications?: number;
                successCount?: number;
                failureCount?: number;
                plugins?: { status: string }[];
            };
            const total = data.totalApplications ?? 0;
            const success = data.successCount ?? 0;
            const fail = data.failureCount ?? 0;
            const pending = total - success - fail;
            stats.push({
                recipeId: data.recipeId ?? name,
                total,
                success,
                fail,
                pending: pending > 0 ? pending : 0,
            });
        } catch {
            warn(`Could not read recipe stats for ${name}`);
        }
    }
    return stats;
}

// ── Build timeline and tag data from plugin aggregated migrations ────────────
interface TimelineEntry {
    month: string;
    success: number;
    fail: number;
    total: number;
}

interface TagEntry {
    tag: string;
    count: number;
}

interface Migration {
    migrationStatus?: string;
    pullRequestStatus?: string;
    timestamp?: string;
    tags?: string[];
}

interface AggregatedMigrations {
    pluginName: string;
    migrations: Migration[];
}

function buildTimelineAndTags(pluginNames: string[]): { timeline: TimelineEntry[]; tags: TagEntry[] } {
    const monthMap = new Map<string, { success: number; fail: number }>();
    const tagMap = new Map<string, number>();

    for (const pluginName of pluginNames) {
        const aggrPath = path.join(PLUGINS_OUT, pluginName, 'reports', 'aggregated_migrations.json');
        if (!fs.existsSync(aggrPath)) continue;

        try {
            const raw = fs.readFileSync(aggrPath, 'utf-8');
            const data = JSON.parse(raw) as AggregatedMigrations;
            if (!Array.isArray(data.migrations)) continue;

            for (const m of data.migrations) {
                // Timeline
                const ts = m.timestamp ?? '';
                const month = ts.substring(0, 7); // "YYYY-MM"
                if (month && month.length === 7) {
                    const entry = monthMap.get(month) ?? { success: 0, fail: 0 };
                    if (m.migrationStatus === 'success') entry.success++;
                    else entry.fail++;
                    monthMap.set(month, entry);
                }

                // Tags
                if (Array.isArray(m.tags)) {
                    for (const tag of m.tags) {
                        tagMap.set(tag, (tagMap.get(tag) ?? 0) + 1);
                    }
                }
            }
        } catch {
            // Skip unreadable files silently
        }
    }

    const timeline: TimelineEntry[] = [...monthMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, counts]) => ({
            month,
            success: counts.success,
            fail: counts.fail,
            total: counts.success + counts.fail,
        }));

    const tags: TagEntry[] = [...tagMap.entries()]
        .sort(([, a], [, b]) => b - a)
        .map(([tag, count]) => ({ tag, count }));

    return { timeline, tags };
}

// ── 2.8 Post-run validation ────────────────────────────────────────────────
function validate(pluginNames: string[], recipeNames: string[]): void {
    const checks = [
        { name: 'summary.json exists', pass: fs.existsSync(path.join(OUTPUT_BASE, 'summary.json')) },
        { name: 'manifest.json exists', pass: fs.existsSync(path.join(OUTPUT_BASE, 'manifest.json')) },
        { name: 'plugin-recipes-index.json has data', pass: pluginNames.length > 0 && recipeNames.length > 0 },
        { name: 'At least 10 plugin dirs', pass: pluginNames.length >= 10 },
        { name: 'At least 1 recipe file', pass: recipeNames.length >= 1 },
        { name: 'recipes.json exists', pass: fs.existsSync(path.join(OUTPUT_BASE, 'recipes.json')) },
    ];

    const failures = checks.filter(c => !c.pass);
    if (failures.length > 0) {
        failures.forEach(f => console.error(`FAIL: ${f.name}`));
        process.exit(1);
    }

    // Error rate check
    const errorRate = errorCount / (pluginNames.length || 1);
    if (errorRate > 0.1) {
        console.error(`FAIL: Error rate ${(errorRate * 100).toFixed(1)}% exceeds 10% threshold.`);
        process.exit(1);
    }

    log('All validations passed.');
}

// ── Main ────────────────────────────────────────────────────────────────────
function main(): void {
    log('Starting consolidation...');
    log(`  INPUT_DIR:  ${INPUT_BASE}`);
    log(`  OUTPUT_DIR: ${OUTPUT_BASE}`);

    if (!fs.existsSync(INPUT_BASE)) {
        console.error(`ERROR: Source directory not found: ${INPUT_BASE}`);
        console.error('       Run the fetch script first: npm run fetch');
        process.exit(1);
    }

    // Clean output directory
    if (fs.existsSync(OUTPUT_BASE)) {
        fs.rmSync(OUTPUT_BASE, { recursive: true });
    }
    ensureDir(OUTPUT_BASE);

    // Parse summary.md
    let summary: SummaryOutput;
    try {
        const mdContent = fs.readFileSync(SUMMARY_MD, 'utf-8');
        summary = parseSummaryMd(mdContent);
    } catch (err) {
        console.error(`ERROR: Failed to parse summary.md: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }

    // Copy recipes
    const recipeNames = copyRecipes();

    // Copy plugin directories
    const pluginNames = copyPlugins();

    // Update plugin count in summary
    summary.overview.totalPlugins = pluginNames.length;

    // Build recipe stats from copied recipe files
    const recipeStats = buildRecipeStatsFromFiles(recipeNames);

    // Build timeline and tags from plugin data
    const { timeline, tags } = buildTimelineAndTags(pluginNames);

    // Compute pending migrations
    let totalPending = 0;
    for (const rs of recipeStats) {
        totalPending += rs.pending;
    }
    summary.overview.pendingMigrations = totalPending;

    // Write enriched summary.json
    const enrichedSummary = {
        ...summary,
        recipes: recipeStats,
        timeline,
        tags,
    };
    fs.writeFileSync(
        path.join(OUTPUT_BASE, 'summary.json'),
        JSON.stringify(enrichedSummary, null, 2),
        'utf-8'
    );
    log('Wrote summary.json');

    // Write plugin-recipes-index.json
    writeIndex(pluginNames, recipeNames, summary.generatedAt);

    // Write recipes.json (combined index)
    writeRecipesJson(recipeNames, summary.generatedAt);

    // Write manifest.json
    writeManifest(pluginNames.length, recipeNames.length, summary.generatedAt);

    // Validation
    validate(pluginNames, recipeNames);

    console.log(`\nBuild summary:`);
    console.log(`  Plugins processed: ${pluginNames.length}`);
    console.log(`  Recipes processed: ${recipeNames.length}`);
    console.log(`  Errors: ${errorCount}`);
    console.log(`  Output: ${OUTPUT_BASE}`);
    if (process.env.BUILD_NUMBER) {
        console.log(`  Jenkins Build: #${process.env.BUILD_NUMBER}`);
    }
}

main();
