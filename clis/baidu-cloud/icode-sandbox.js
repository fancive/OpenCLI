import { cli, Strategy } from '@jackwener/opencli/registry';

const REPO_PATTERN = /^[\w-]+(\/[\w.-]+)+$/;

/**
 * iPipe API endpoints:
 *   GET /api/ipipe/pipeline/rest/v1/pipelines?module={repo}&workspaceId={id}&_limit=50
 *   GET /api/ipipe/pipeline/rest/v1/pipelines/{id}/versions/ALL/branches?module={repo}&hasBuilds=true&_limit=100
 * sandbox 分支优先使用显式 `{repo}_shahe_...` 命名，旧分支通过 remark 中的"沙盒"识别。
 */

const WORKSPACE_MAP = {
  'amisapi': 141290,
  'gms-v3': 374942,
  'sapi-v2': 401746,
  'servergoapi': 323040,
};

export function selectSandboxBranches(branches, repoShort) {
  const explicitPattern = new RegExp('^' + repoShort + '_shahe_1-0-(\\d+)_BRANCH$');
  const legacyPattern = new RegExp('^' + repoShort + '_1-0-(\\d+)_BRANCH$');

  return branches
    .map((branch) => {
      const name = typeof branch?.name === 'string' ? branch.name : '';
      const remark = typeof branch?.remark === 'string' ? branch.remark : '';
      const explicitMatch = name.match(explicitPattern);
      const legacyMatch = /沙盒|sandbox/i.test(remark) ? name.match(legacyPattern) : null;
      const match = explicitMatch || legacyMatch;
      if (!match) return null;
      return {
        name,
        num: Number.parseInt(match[1], 10),
        remark,
        explicitShahe: Boolean(explicitMatch),
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.explicitShahe) - Number(a.explicitShahe) || b.num - a.num);
}

cli({
  site: 'baidu-cloud',
  name: 'icode-sandbox',
  access: 'read',
  description: '通过 iPipe API 查找 iCode 仓库的沙盒分支',
  domain: 'console.cloud.baidu-int.com',
  strategy: Strategy.COOKIE,
  args: [
    { name: 'repo', type: 'string', required: true, positional: true, help: '仓库路径, 如 baidu/inputmethod/gms-v3' },
    { name: 'workspace', type: 'int', help: 'workspace ID (自动推断, 也可手动指定)' },
  ],
  columns: ['branch', 'remark', 'status', 'time', 'user'],
  func: async (page, kwargs) => {
    const repo = kwargs.repo;
    if (!REPO_PATTERN.test(repo)) {
      return [{ branch: '', remark: '(invalid repo path)', status: 'error', time: '', user: '' }];
    }

    const repoShort = repo.split('/').pop();
    let workspaceId = kwargs.workspace;
    if (!workspaceId) workspaceId = WORKSPACE_MAP[repoShort];
    if (!workspaceId) {
      return [{ branch: '', remark: `unknown workspace for ${repoShort}, use --workspace`, status: 'error', time: '', user: '' }];
    }

    await page.goto(`https://console.cloud.baidu-int.com/devops/ipipe/workspaces/${workspaceId}/pipelines/list`);
    await page.wait(3);

    return await page.evaluate(`
      (async () => {
        const repo = ${JSON.stringify(repo)};
        const repoShort = ${JSON.stringify(repoShort)};
        const workspaceId = ${JSON.stringify(workspaceId)};

        const pipRes = await fetch(
          '/api/ipipe/pipeline/rest/v1/pipelines?module=' + encodeURIComponent(repo)
            + '&_offset=0&_limit=50&trashStatus=false&workspaceId=' + workspaceId,
          { credentials: 'include' }
        );
        const pipData = await pipRes.json();
        const pipelines = pipData.entities?.pipelines || [];
        const changePip = pipelines.find(p => p.name === 'ChangePipeline');
        if (!changePip) {
          return [{ branch: '', remark: 'ChangePipeline not found', status: 'error', time: '', user: '' }];
        }

        const brRes = await fetch(
          '/api/ipipe/pipeline/rest/v1/pipelines/' + changePip.id
            + '/versions/ALL/branches?module=' + encodeURIComponent(repo)
            + '&validBranch=true&hasBuilds=true&_offset=0&_limit=100',
          { credentials: 'include' }
        );
        const brRaw = await brRes.json();
        const branches = Array.isArray(brRaw) ? brRaw : (brRaw.entities?.branches || []);

        const selectSandboxBranches = ${selectSandboxBranches.toString()};
        const sandbox = selectSandboxBranches(branches, repoShort);

        if (sandbox.length === 0) {
          return [{ branch: '', remark: 'no explicit shahe branch or sandbox remark found', status: 'not_found', time: '', user: '' }];
        }

        const sandboxNames = sandbox.slice(0, 5).map(b => b.name).join(',');
        const buildRes = await fetch(
          '/api/ipipe/pipeline/rest/v1/pipelines/' + changePip.id
            + '/lastPipelineBuilds?branchNames=' + encodeURIComponent(sandboxNames),
          { credentials: 'include' }
        );
        const buildRaw = await buildRes.json();
        const builds = Array.isArray(buildRaw) ? buildRaw : [];

        return sandbox.slice(0, 5).map((s, i) => {
          const build = builds.find(bd => bd.branchName === s.name);
          return {
            branch: s.name + (i === 0 ? ' ← current' : ''),
            remark: s.remark,
            status: build?.status || 'no build',
            time: build?.startTime ? new Date(build.startTime).toISOString().slice(0, 16) : '',
            user: build?.triggerUser || '',
          };
        });
      })()
    `);
  },
});
