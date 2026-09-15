import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { getRegistry } from '@jackwener/opencli/registry';
import { createPageMock } from '../test-utils.js';
import './amisapi-sandbox-deploy.js';
import { AMISAPI_IPIPE, buildDeployConfirmation, validateDeployArgs } from './amisapi-sandbox-deploy.js';

const BRANCH = 'amisapi_1-0-1093_BRANCH';
const SHA = '5e9183dbddb216d18b391968de968c05a55d52b0';
const BUILD_ID = '270189838';

describe('baidu-cloud amisapi-sandbox-deploy', () => {
  it('binds the confirmation to workspace, pipeline, branch, full SHA and build ID', () => {
    expect(buildDeployConfirmation(BRANCH, SHA.toUpperCase(), BUILD_ID)).toBe(
      `deploy-amisapi-sandbox workspace=${AMISAPI_IPIPE.workspaceId} pipeline=deploy branch=${BRANCH} sha=${SHA} build=${BUILD_ID}`,
    );
  });

  it('requires exact deploy evidence and confirmation before opening the page', async () => {
    expect(() => validateDeployArgs({ branch: BRANCH, action: 'deploy' })).toThrow(/expected-sha.*build-id/);

    const cmd = getRegistry().get('baidu-cloud/amisapi-sandbox-deploy');
    const page = createPageMock();
    await expect(cmd.func(page, {
      branch: BRANCH,
      action: 'deploy',
      'expected-sha': SHA,
      'build-id': BUILD_ID,
      confirm: 'wrong',
    })).rejects.toMatchObject({ code: 'ARGUMENT' });
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('rejects shortened SHAs and unsafe branch values', () => {
    expect(() => validateDeployArgs({ branch: BRANCH, action: 'preview', 'expected-sha': '5e9183d' })).toThrow(/40 位/);
    expect(() => validateDeployArgs({ branch: '../bad', action: 'preview' })).toThrow(/Git 分支名/);
  });

  it('previews the exact branch and returns a copyable confirmation without starting a write', async () => {
    const confirmation = buildDeployConfirmation(BRANCH, SHA, BUILD_ID);
    const page = createPageMock([{
      ok: true,
      writeStarted: false,
      snapshot: {
        branch: BRANCH,
        buildId: BUILD_ID,
        buildNumber: '#3274',
        revision: SHA,
        stage: '部署沙盒',
        executable: true,
        confirmation,
      },
    }]);
    const cmd = getRegistry().get('baidu-cloud/amisapi-sandbox-deploy');

    const result = await cmd.func(page, { branch: BRANCH, action: 'preview', wait: 20 });

    expect(page.goto).toHaveBeenCalledWith(
      `https://console.cloud.baidu-int.com/devops/ipipe/workspaces/141290/pipelines/1204612/builds/list?branchName=${BRANCH}`,
    );
    expect(page.wait).toHaveBeenCalledWith(3);
    const script = page.evaluate.mock.calls[0][0];
    expect(script).toContain('ul[role="tablist"]');
    expect(script).toContain('/pipeline-builds\\/(\\d+)\\/view');
    expect(script).toContain('/commits\\/([0-9a-f]{40})');
    expect(script).toContain("title === stageName");
    expect(script).toContain("text(el) === '执行'");
    expect(script).toContain('[class*="RoundButton"]');
    expect(result).toEqual([{
      action: 'preview',
      branch: BRANCH,
      build: '#3274 (270189838)',
      revision: SHA,
      stage: '部署沙盒',
      status: 'ready',
      detail: confirmation,
    }]);
  });

  it('parses the real iPipe build-row shape and scopes execute to the deploy sandbox stage', async () => {
    const dom = new JSDOM(`
      <ul role="tablist">
        <li role="tab">
          <a href="/devops/ipipe/workspaces/141290/pipeline-builds/${BUILD_ID}/view">#3274</a>
          <a href="http://console.cloud.baidu-int.com/devops/icode/repos/baidu/inputmethod/amisapi/commits/${SHA}">5e9183d</a>
        </li>
        <li role="tab"><span title="编译">编译</span><div>成功</div></li>
        <li role="tab"><span title="部署沙盒">部署沙盒</span><div class="stage-operation"><svg></svg>执行</div></li>
      </ul>
    `, {
      url: `https://console.cloud.baidu-int.com/devops/ipipe/workspaces/141290/pipelines/1204612/builds/list?branchName=${BRANCH}`,
      runScripts: 'outside-only',
    });
    dom.window.HTMLElement.prototype.getClientRects = function getClientRects() {
      return [{ width: 1, height: 1, top: 0, left: 0, right: 1, bottom: 1 }];
    };
    const page = createPageMock([], {
      evaluate: async (script) => dom.window.eval(String(script)),
    });
    const cmd = getRegistry().get('baidu-cloud/amisapi-sandbox-deploy');

    const [result] = await cmd.func(page, {
      branch: BRANCH,
      action: 'preview',
      'expected-sha': SHA,
      wait: 20,
    });

    expect(result).toMatchObject({
      build: '#3274 (270189838)',
      revision: SHA,
      stage: '部署沙盒',
      status: 'ready',
    });
  });

  it('does not accept a build whose revision differs from expected-sha', async () => {
    const page = createPageMock([{
      ok: false,
      writeStarted: false,
      message: '构建 revision 与 expected-sha 不一致',
    }]);
    const cmd = getRegistry().get('baidu-cloud/amisapi-sandbox-deploy');

    await expect(cmd.func(page, {
      branch: BRANCH,
      action: 'preview',
      'expected-sha': SHA,
      wait: 20,
    })).rejects.toMatchObject({ code: 'COMMAND_EXEC' });
  });

  it('reports an uncertain post-click result as a timeout that must be read back', async () => {
    const confirmation = buildDeployConfirmation(BRANCH, SHA, BUILD_ID);
    const page = createPageMock([{
      ok: false,
      writeStarted: true,
      unconfirmed: true,
      message: '已点击部署沙盒，但页面未在期限内出现状态变化',
    }]);
    const cmd = getRegistry().get('baidu-cloud/amisapi-sandbox-deploy');

    await expect(cmd.func(page, {
      branch: BRANCH,
      action: 'deploy',
      'expected-sha': SHA,
      'build-id': BUILD_ID,
      confirm: confirmation,
      wait: 20,
    })).rejects.toMatchObject({
      code: 'TIMEOUT',
      hint: expect.stringContaining('禁止直接重试'),
    });
  });
});
