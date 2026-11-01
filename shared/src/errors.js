// 失败一律是 { error: { code, message } }。message 给人看，员工端和管理端按 code 判断怎么恢复。
export const ERRORS = Object.freeze({
  INVALID_INPUT: [400, '提交的内容格式不对'],
  AUTH_REQUIRED: [401, '需要先登录'],
  AUTH_INVALID: [401, '登录名或密码不对'],
  AUTH_EXPIRED: [401, '登录已过期，请重新登录'],
  AUTH_LOCKED: [429, '密码连续输错次数太多，请 15 分钟后再试'],
  ACCOUNT_DISABLED: [403, '账号已被管理员停用'],
  FORBIDDEN: [403, '没有权限做这件事'],
  CSRF: [403, '请从管理端页面操作'],
  NOT_FOUND: [404, '要找的内容不存在，或者你没有权限查看'],
  CONFLICT: [409, '内容已被别人改过，请重新读取后再改'],
  EXISTS: [409, '同名的内容已经存在'],
  IN_USE: [409, '还在使用中，不能删除'],
  INVITE_INVALID: [404, '邀请链接无效'],
  INVITE_EXPIRED: [410, '邀请链接已过期、已撤销或名额已用完'],
  SETUP_REQUIRED: [503, '服务端还没有初始化，请管理员先打开管理端完成初始化'],
  SETUP_DONE: [409, '服务端已经初始化过了'],
  SETUP_CODE: [403, '初始化码不对，请看服务端启动日志或数据目录里的 setup-code.txt'],
  TOO_LARGE: [413, '内容太大'],
  RATE_LIMITED: [429, '请求太频繁，请稍后再试'],
  INTERNAL: [500, '服务端出错了，请管理员查看服务端日志'],
});

export class ApiError extends Error {
  constructor(code, message, details) {
    const known = ERRORS[code] ?? ERRORS.INTERNAL;
    super(message || known[1]);
    this.name = 'ApiError';
    this.code = ERRORS[code] ? code : 'INTERNAL';
    this.status = known[0];
    if (details !== undefined) this.details = details;
  }
}

export const apiError = (code, message, details) => new ApiError(code, message, details);
