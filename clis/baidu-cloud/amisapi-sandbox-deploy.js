import { ArgumentError, CommandExecutionError, TimeoutError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';

export const AMISAPI_IPIPE = Object.freeze({
  workspaceId: '141290',
  pipelineId: '1204612',
  pipelineName: 'deploy',
  stageName: '部署沙盒',
});

const BRANCH_PATTERN = /^(?!-)(?!.*(?:\.\.|\/\/))[A-Za-z0-9._/-]{1,200}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function buildDeployConfirmation(branch, sha, buildId) {
  return [
    'deploy-amisapi-sandbox',
    `workspace=${AMISAPI_IPIPE.workspaceId}`,
    `pipeline=${AMISAPI_IPIPE.pipelineName}`,
    `branch=${branch}`,
    `sha=${sha.toLowerCase()}`,
    `build=${buildId}`,
  ].join(' ');
}

export function validateDeployArgs(kwargs) {
  const branch = String(kwargs.branch || '');
  const action = String(kwargs.action || 'preview');
  const expectedSha = String(kwargs['expected-sha'] || '').toLowerCase();
  const buildId = kwargs['build-id'] == null ? '' : String(kwargs['build-id']);

  if (!BRANCH_PATTERN.test(branch) || branch.endsWith('/') || branch.endsWith('.')) {
    throw new ArgumentError('branch 不是有效的 Git 分支名');
  }
  if (expectedSha && !SHA_PATTERN.test(expectedSha)) {
    throw new ArgumentError('expected-sha 必须是 40 位完整 commit SHA');
  }
  if (buildId && !/^\d+$/.test(buildId)) {
    throw new ArgumentError('build-id 必须是数字 ID');
  }
  if (!['preview', 'deploy'].includes(action)) {
    throw new ArgumentError('action 只能是 preview 或 deploy');
  }
  if (action === 'deploy') {
    if (!expectedSha || !buildId) {
      throw new ArgumentError('deploy 必须同时提供 --expected-sha 和 --build-id；先运行 preview 取得候选');
    }
    const expectedConfirmation = buildDeployConfirmation(branch, expectedSha, buildId);
    if (String(kwargs.confirm || '') !== expectedConfirmation) {
      throw new ArgumentError('confirm 与本次 workspace/pipeline/branch/SHA/build 不匹配', `请使用 preview 返回的确认串：${expectedConfirmation}`);
    }
  }

  return { branch, action, expectedSha, buildId };
}

export function buildBrowserScript({ branch, action, expectedSha, buildId, waitSeconds }) {
  return `(async () => {
    const branch = ${JSON.stringify(branch)};
    const action = ${JSON.stringify(action)};
    const expectedSha = ${JSON.stringify(expectedSha)};
    const requestedBuildId = ${JSON.stringify(buildId)};
    const waitSeconds = ${JSON.stringify(waitSeconds)};
    const stageName = ${JSON.stringify(AMISAPI_IPIPE.stageName)};
    let writeStarted = false;

    const visible = (el) => Boolean(el && el.getClientRects().length > 0);
    const text = (el) => String(el?.textContent || '').trim();
    const buildIdFromHref = (href) => href.match(/\\/pipeline-builds\\/(\\d+)\\/view(?:[?#]|$)/)?.[1] || '';
    const shaFromHref = (href) => href.match(/\\/commits\\/([0-9a-f]{40})(?:[/?#]|$)/i)?.[1]?.toLowerCase() || '';

    const currentUrl = new URL(window.location.href);
    if (currentUrl.searchParams.get('branchName') !== branch) {
      return { ok: false, message: '页面未选中目标 branch', writeStarted };
    }

    const collectRows = () => [...document.querySelectorAll('ul[role="tablist"]')].map((row) => {
      const buildLink = [...row.querySelectorAll('a[href]')].find((a) => buildIdFromHref(a.getAttribute('href') || ''));
      const revisionLink = [...row.querySelectorAll('a[href]')].find((a) => shaFromHref(a.getAttribute('href') || ''));
      if (!buildLink || !revisionLink) return null;

      const rowBuildId = buildIdFromHref(buildLink.getAttribute('href') || '');
      const revision = shaFromHref(revisionLink.getAttribute('href') || '');
      const stage = [...row.querySelectorAll('li[role="tab"]')].find((item) => {
        const title = item.querySelector('[title]')?.getAttribute('title') || '';
        return title === stageName || text(item.querySelector('[title]')) === stageName;
      });
      const executeLeaves = stage
        ? [...stage.querySelectorAll('button, a, [role="button"], div, span')].filter((el) => (
          visible(el)
          && text(el) === '执行'
          && ![...el.children].some((child) => text(child) === '执行')
        ))
        : [];
      const executeCandidates = [...new Set(executeLeaves.map((el) => (
        el.closest('button, a, [role="button"], [class*="RoundButton"]') || el
      )))];
      return {
        row,
        stage,
        execute: executeCandidates.length === 1 ? executeCandidates[0] : null,
        executeCount: executeCandidates.length,
        buildId: rowBuildId,
        buildNumber: text(buildLink),
        revision,
      };
    }).filter(Boolean);

    const rows = collectRows();

    if (rows.length === 0) {
      return { ok: false, message: '当前分支没有可识别的 deploy 构建', writeStarted };
    }
    const candidate = requestedBuildId ? rows.find((row) => row.buildId === requestedBuildId) : rows[0];
    if (!candidate) {
      return { ok: false, message: 'build-id 不属于当前分支页面', writeStarted };
    }
    if (expectedSha && candidate.revision !== expectedSha) {
      return { ok: false, message: '构建 revision 与 expected-sha 不一致', writeStarted };
    }

    const executable = Boolean(candidate.stage && candidate.execute && candidate.executeCount === 1);
    const confirmation = [
      'deploy-amisapi-sandbox',
      'workspace=${AMISAPI_IPIPE.workspaceId}',
      'pipeline=${AMISAPI_IPIPE.pipelineName}',
      'branch=' + branch,
      'sha=' + candidate.revision,
      'build=' + candidate.buildId,
    ].join(' ');
    const snapshot = {
      branch,
      buildId: candidate.buildId,
      buildNumber: candidate.buildNumber,
      revision: candidate.revision,
      stage: stageName,
      executable,
      confirmation,
    };
    if (action === 'preview') return { ok: true, writeStarted, snapshot };
    if (!executable) {
      return { ok: false, message: '目标构建的部署沙盒阶段不是唯一可执行状态', writeStarted, snapshot };
    }

    candidate.execute.scrollIntoView({ block: 'center' });
    writeStarted = true;
    candidate.execute.click();
    await new Promise((resolve) => setTimeout(resolve, 800));

    const roleDialogs = [...document.querySelectorAll('[role="dialog"]')]
      .filter((dialog) => visible(dialog) && text(dialog));
    const dialogs = roleDialogs.length > 0
      ? roleDialogs
      : [...document.querySelectorAll('.ant-modal-wrap')].filter((dialog) => visible(dialog) && text(dialog));
    if (dialogs.length > 1) {
      return { ok: false, unconfirmed: true, message: '执行后出现多个确认弹窗，无法唯一确认', writeStarted, snapshot };
    }
    if (dialogs.length === 1) {
      const dialog = dialogs[0];
      const confirmButtons = [...dialog.querySelectorAll('button, [role="button"]')]
        .filter((el) => visible(el) && /^(确认|确定|确认执行)$/.test(text(el)) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
      if (confirmButtons.length !== 1) {
        return { ok: false, unconfirmed: true, message: '确认弹窗中没有唯一的确认按钮', writeStarted, snapshot };
      }
      confirmButtons[0].click();
    }

    const deadline = Date.now() + waitSeconds * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const refreshed = collectRows().find((row) => row.buildId === candidate.buildId);
      if (!refreshed) continue;
      const stageText = text(refreshed.stage);
      if (!refreshed.execute || /执行中|排队|构建中|成功|失败/.test(stageText)) {
        return { ok: true, writeStarted, snapshot: { ...snapshot, executable: false }, message: '部署沙盒阶段已离开待执行状态' };
      }
    }
    return { ok: false, unconfirmed: true, message: '已点击部署沙盒，但页面未在期限内出现状态变化', writeStarted, snapshot };
  })()`;
}

cli({
  site: 'baidu-cloud',
  name: 'amisapi-sandbox-deploy',
  access: 'write',
  description: '在 amisapi iPipe deploy 流水线中预览或执行指定沙盒分支的部署沙盒阶段',
  domain: 'console.cloud.baidu-int.com',
  strategy: Strategy.COOKIE,
  timeoutSeconds: 30,
  args: [
    { name: 'branch', type: 'string', required: true, positional: true, help: '已合入 feature 的 amisapi 沙盒分支' },
    { name: 'action', type: 'string', default: 'preview', choices: ['preview', 'deploy'], help: 'preview 只读输出候选；deploy 点击部署沙盒阶段' },
    { name: 'expected-sha', type: 'string', help: '沙盒分支完整 40 位 HEAD SHA；deploy 必填' },
    { name: 'build-id', type: 'string', help: 'preview 返回的 pipeline build ID；deploy 必填' },
    { name: 'confirm', type: 'string', help: 'preview 返回的精确确认串；deploy 必填' },
    { name: 'wait', type: 'int', default: 20, help: '点击后等待页面状态变化的秒数，1-25' },
  ],
  columns: ['action', 'branch', 'build', 'revision', 'stage', 'status', 'detail'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser session required for amisapi sandbox deploy');
    const args = validateDeployArgs(kwargs);
    const waitSeconds = Number(kwargs.wait ?? 20);
    if (!Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 25) {
      throw new ArgumentError('wait 必须是 1-25 的整数');
    }

    const url = `https://console.cloud.baidu-int.com/devops/ipipe/workspaces/${AMISAPI_IPIPE.workspaceId}/pipelines/${AMISAPI_IPIPE.pipelineId}/builds/list?branchName=${encodeURIComponent(args.branch)}`;
    await page.goto(url);
    await page.wait(3);
    const result = await page.evaluate(buildBrowserScript({ ...args, waitSeconds }));
    if (!result || typeof result !== 'object') {
      throw new CommandExecutionError('iPipe 页面返回了不可识别的结果');
    }
    if (!result.ok) {
      if (result.unconfirmed || result.writeStarted) {
        throw new TimeoutError('amisapi 部署沙盒状态确认', waitSeconds, `${result.message}；先回读同一 build，禁止直接重试。`);
      }
      throw new CommandExecutionError(result.message, '页面结构或目标状态可能已变化；重新 preview 后再决定。');
    }

    const snapshot = result.snapshot || {};
    return [{
      action: args.action,
      branch: snapshot.branch || args.branch,
      build: snapshot.buildId ? `${snapshot.buildNumber || ''} (${snapshot.buildId})`.trim() : '',
      revision: snapshot.revision || '',
      stage: snapshot.stage || AMISAPI_IPIPE.stageName,
      status: args.action === 'preview' ? (snapshot.executable ? 'ready' : 'not_ready') : 'triggered',
      detail: args.action === 'preview' ? snapshot.confirmation : result.message,
    }];
  },
});
