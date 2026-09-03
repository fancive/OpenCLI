import { describe, expect, it } from 'vitest';
import { selectSandboxBranches } from './icode-sandbox.js';

describe('baidu-cloud icode-sandbox selection', () => {
  it('prefers an explicitly named shahe branch over newer generic candidates', () => {
    const selected = selectSandboxBranches(
      [
        { name: 'gms-v3_1-0-1019_BRANCH', remark: 'sandbox-request-log 记录请求域名' },
        { name: 'gms-v3_1-0-798_BRANCH', remark: '20260107沙盒专用部署分支' },
        { name: 'gms-v3_shahe_1-0-1010_BRANCH', remark: '' },
      ],
      'gms-v3',
    );

    expect(selected.map((item) => item.name)).toEqual([
      'gms-v3_shahe_1-0-1010_BRANCH',
      'gms-v3_1-0-1019_BRANCH',
      'gms-v3_1-0-798_BRANCH',
    ]);
  });

  it('keeps the highest numbered legacy sandbox first when no explicit branch exists', () => {
    const selected = selectSandboxBranches(
      [
        { name: 'sapi-v2_1-0-2104_BRANCH', remark: 'sandbox 域名替换' },
        { name: 'sapi-v2_1-0-1970_BRANCH', remark: '沙盒专用部署分支' },
        { name: 'sapi-v2_1-0-2200_BRANCH', remark: '普通 feature' },
      ],
      'sapi-v2',
    );

    expect(selected.map((item) => item.name)).toEqual([
      'sapi-v2_1-0-2104_BRANCH',
      'sapi-v2_1-0-1970_BRANCH',
    ]);
  });
});
