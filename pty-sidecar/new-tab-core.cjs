'use strict';
// Pure helpers for `new-tab`, shared by both CLIs that send it: `cos-coord new-tab` (the overseer,
// through god-outbox/) and `wcc-client new-tab` (an outside caller, through the connector channel).
// No IO. The app validates the same fields again (src/new-tab.ts parseNewTabFields) and is the
// authority; tests/new-tab-cli.test.ts holds the two to one field set and one set of enum values.
// Reference: docs/api.md, "new-tab".

const GITIGNORE_KINDS = ['general', 'node', 'python', 'none'];
const REMOTE_CHOICES = ['none', 'private', 'public'];

// Creating a repo runs git init/add/commit and, with a remote, `gh repo create --push`, whose own
// timeout is 60s — so the default wait is longer than a spawn's.
const NEW_TAB_WAIT_MS = 120000;

// 4 = it failed, BUT a folder was created: the repo exists without its initial commit. Not 2,
// because 2 promises nothing happened.
const EXIT_LEFT_ON_DISK = 4;

const VALUE_FLAGS = ['--repo', '--new-repo', '--parent', '--base', '--gitignore', '--remote'];
const BOOL_FLAGS = ['--claude-md', '--no-claude-md', '--json'];

/** cos-coord's argv after `new-tab`: one positional (the tab name) and the flags above. Strict —
 *  an unknown or misspelt flag is an error, never a silently different repo. */
function parseNewTabArgv(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.includes(a)) {
        if (i + 1 >= argv.length) return { ok: false, reason: `${a} needs a value` };
        flags[a.slice(2)] = argv[++i];
      } else if (BOOL_FLAGS.includes(a)) {
        flags[a.slice(2)] = true;
      } else {
        return { ok: false, reason: `unknown flag ${a}` };
      }
      continue;
    }
    positional.push(a);
  }
  if (positional.length > 1) return { ok: false, reason: `takes one tab name, got ${positional.length} words — quote it` };
  return { ok: true, name: positional[0] || '', flags };
}

/** The request's new-tab fields from a tab name and parsed flags. `resolvePath` makes a relative
 *  --parent absolute against the caller's own working directory (the app only takes absolute). */
function buildNewTabFields(name, flags, resolvePath) {
  if (!name || !String(name).trim()) return { ok: false, reason: 'needs a tab name: new-tab "<name>" [--repo <target> | --new-repo <name> …]' };
  if (flags['claude-md'] && flags['no-claude-md']) return { ok: false, reason: '--claude-md and --no-claude-md contradict each other' };
  const gitignore = flags.gitignore || null;
  if (gitignore && !GITIGNORE_KINDS.includes(gitignore)) return { ok: false, reason: `invalid --gitignore "${gitignore}". Valid: ${GITIGNORE_KINDS.join(', ')}` };
  const remote = flags.remote || null;
  if (remote && !REMOTE_CHOICES.includes(remote)) return { ok: false, reason: `invalid --remote "${remote}". Valid: ${REMOTE_CHOICES.join(', ')}` };
  const claudeMd = flags['claude-md'] ? true : flags['no-claude-md'] ? false : null;
  return {
    ok: true,
    fields: {
      name: String(name).trim(),
      repo: flags.repo || null,
      newRepo: flags['new-repo'] || null,
      parent: flags.parent ? resolvePath(flags.parent) : null,
      base: flags.base || null,
      gitignore,
      claudeMd,
      remote,
    },
  };
}

/** Either channel's receipt → an outcome. god-outbox receipts say `ok`; connector receipts say
 *  `status`. Anything that is not a well-formed success is a failure with a reason. */
function interpretNewTabReceipt(r) {
  const ok = r && (r.ok === true || r.status === 'accepted');
  if (ok && r.newTab && typeof r.newTab.workspaceId === 'string') return { ok: true, result: r.newTab };
  const reason = r && typeof r.reason === 'string' && r.reason ? r.reason : ok ? 'accepted without a result (malformed receipt)' : 'rejected without a reason (malformed receipt)';
  return { ok: false, reason, ...(r && typeof r.leftOnDisk === 'string' ? { leftOnDisk: r.leftOnDisk } : {}) };
}

/** What a CLI prints to stderr on success; stdout carries only the workspace id (or --json). */
function formatNewTabResult(res) {
  const lines = [
    `tab "${res.tab}" (workspace ${res.workspaceId}) on ${res.repo} — ${res.repoPath}${res.created ? `, created on branch ${res.branch}` : ''}`,
    `coord dir: ${res.coordDir}`,
  ];
  if (res.remoteUrl) lines.push(`remote: ${res.remoteUrl}`);
  for (const w of res.warnings || []) lines.push(`warning: ${w}`);
  return lines.join('\n');
}

module.exports = {
  GITIGNORE_KINDS, REMOTE_CHOICES, NEW_TAB_WAIT_MS, EXIT_LEFT_ON_DISK, VALUE_FLAGS, BOOL_FLAGS,
  parseNewTabArgv, buildNewTabFields, interpretNewTabReceipt, formatNewTabResult,
};
