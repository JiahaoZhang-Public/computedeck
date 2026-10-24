import { afterEach, describe, expect, it } from 'vitest';
import en from './locales/en';
import zhCN from './locales/zh-CN';
import { ApiError, errorText, formatMessage, setLocale, t } from './i18n';
import { statusLabel, statusTone } from './labels';

afterEach(() => setLocale('en'));

describe('translations', () => {
  it('defines the same keys and placeholders in every language', () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[])
      expect([key, placeholders(zhCN[key])]).toEqual([key, placeholders(en[key])]);
  });
  it('defaults to English and switches without reloading', () => {
    expect(t('nav.jobs')).toBe('Jobs');
    expect(t('time.minutesAgo', { count: 3 })).toBe('3 min ago');
    expect(t('overview.instances', { count: 1 })).toBe('1 instance');
    expect(t('overview.instances', { count: 2 })).toBe('2 instances');
    setLocale('zh-CN');
    expect(t('nav.jobs')).toBe('作业');
    expect(statusLabel('PENDING')).toBe('排队中');
    expect(statusLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
  it('labels provider-reported running separately from a starting instance', () => {
    expect(statusLabel('reported_running')).toBe('Running (reported by provider)');
    expect(statusTone('reported_running')).toBe('green');
    expect(statusLabel('desired_running')).toBe('Expected running');
    expect(statusTone('desired_running')).toBe('amber');
    setLocale('zh-CN');
    expect(statusLabel('reported_running')).toBe('运行中（服务商报告）');
    expect(statusLabel('desired_running')).toBe('期望运行');
  });
  it('spaces Latin names and numbers from Chinese text', () => {
    setLocale('zh-CN');
    expect(t('market.installNote', { where: 'gpu-box' })).toContain('需要在 gpu-box 上用');
    expect(t('market.installNote', { where: '本机' })).toContain('需要在本机上用');
    expect(t('toolbox.turnedOn', { name: '任务提醒' })).toBe('已开启任务提醒');
  });
  it('renders server messages with parameters and keeps untranslated remote detail', () => {
    expect(formatMessage({ code: 'http_status', status: 401 })).toBe('The API returned HTTP 401');
    expect(formatMessage({ code: 'ssh_failed', detail: 'Permission denied' })).toBe(
      'SSH failed: Permission denied',
    );
    expect(formatMessage({ code: 'brand_new_code' })).toBe('brand_new_code');
    expect(formatMessage('plain text')).toBe('plain text');
    expect(formatMessage(null)).toBe('');
  });
  it('turns API errors into readable text', () => {
    expect(errorText(new ApiError(404, { code: 'source_not_found' }), 'error.save')).toBe(
      'Source not found',
    );
    expect(errorText(new ApiError(500, null), 'error.save')).toBe('Request failed (HTTP 500)');
    expect(errorText('nonsense', 'error.save')).toBe('Could not save');
  });
  it.each([
    {
      code: 'ssh_authentication',
      detail: 'Permission denied (publickey).',
      en: 'SSH authentication rejected (check the login name and key on the collecting machine): Permission denied (publickey).',
      zh: 'SSH 认证被拒绝（检查采集机器上的登录用户名和密钥）: Permission denied (publickey).',
    },
    {
      code: 'ssh_host_key',
      detail: 'Host key verification failed.',
      en: 'SSH host identity verification failed (verify the host key with its administrator before updating known_hosts): Host key verification failed.',
      zh: 'SSH 主机身份验证失败（更新 known_hosts 前，请向管理员核实主机密钥）: Host key verification failed.',
    },
    {
      code: 'ssh_network',
      detail: 'No route to host',
      en: 'SSH could not reach the host (check the network, VPN and jump-host route): No route to host',
      zh: 'SSH 无法到达主机（检查网络、VPN 和跳板路由）: No route to host',
    },
    {
      code: 'ssh_refused',
      detail: 'Connection refused',
      en: 'The host refused SSH (check the port and whether its SSH service is running): Connection refused',
      zh: '主机拒绝了 SSH 连接（检查端口及远端 SSH 服务是否运行）: Connection refused',
    },
    {
      code: 'ssh_closed',
      detail: 'kex_exchange_identification: Connection closed by remote host',
      en: 'The SSH connection closed before the check completed (retry the check): kex_exchange_identification: Connection closed by remote host',
      zh: 'SSH 连接在检查完成前关闭（请重试检查）: kex_exchange_identification: Connection closed by remote host',
    },
  ])('renders $code with remote detail in both languages', ({ code, detail, en, zh }) => {
    const ssh_error = { code, detail };
    expect(formatMessage(ssh_error)).toBe(en);
    setLocale('zh-CN');
    expect(formatMessage(ssh_error)).toBe(zh);
  });
});

it.each(['en', 'zh-CN'] as const)('renders unreadable-row counts in %s', (locale) => {
  setLocale(locale);
  for (const count of [1, 2]) {
    const text = formatMessage({ code: 'attention_unreadable_rows', name: 'jobs', count });
    expect(text).toBe(
      t(`msg.attention_unreadable_rows${count === 1 ? '.one' : ''}`, { name: 'jobs', count }),
    );
    if (locale === 'en')
      expect(text).toContain(`${count} unreadable ${count === 1 ? 'row;' : 'rows;'}`);
  }
});

it.each(['en', 'zh-CN'] as const)('uses singular count hints in %s', (locale) => {
  setLocale(locale);
  expect(t('jobs.lastKnownCount', { count: 1 })).toBe(
    locale === 'en' ? '+1 last-known job not counted' : '+1 个上次已知作业未计入',
  );
  expect(t('summary.unknownNodes', { count: 1 })).toBe(
    locale === 'en' ? '1 node has unknown state or measurements' : '1 个节点的状态或测量数据未知',
  );
  if (locale === 'en') {
    expect(t('jobs.lastKnownCount', { count: 2 })).toBe('+2 last-known jobs not counted');
    expect(t('summary.unknownNodes', { count: 2 })).toBe(
      '2 nodes have unknown state or measurements',
    );
  }
});

it.each(['en', 'zh-CN'] as const)('pluralizes array hints in %s', (locale) => {
  setLocale(locale);
  expect(t('jobs.array.elements', { count: 1 })).toBe(
    locale === 'en'
      ? 'The 1 listed element, including any last-known job. Open it for details.'
      : '共 1 个已列出的数组元素，包含保留的上次观测作业。打开元素可查看详情。',
  );
  expect(t('jobs.array.elements', { count: 2 })).toBe(
    locale === 'en'
      ? 'All 2 listed elements, including any last-known jobs. Open an element for details.'
      : '共 2 个已列出的数组元素，包含保留的上次观测作业。打开元素可查看详情。',
  );
  expect(t('jobs.array.otherReasons', { count: 1 })).toBe(
    locale === 'en' ? '+1 other reason' : '另有 1 种等待原因',
  );
  expect(t('jobs.array.otherReasons', { count: 2 })).toBe(
    locale === 'en' ? '+2 other reasons' : '另有 2 种等待原因',
  );
  expect(t('jobs.array.unknownGpus', { count: 1 })).toBe(
    locale === 'en' ? 'GPU count unknown for 1 allocated job' : '1 个占用资源的作业 GPU 数量未知',
  );
  expect(t('jobs.array.unknownGpus', { count: 2 })).toBe(
    locale === 'en' ? 'GPU count unknown for 2 allocated jobs' : '2 个占用资源的作业 GPU 数量未知',
  );
});
