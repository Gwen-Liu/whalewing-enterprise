// DSH Host 入口：登记鲸翼扩展、接上专家来源和知识来源、按企业设置给小鲸改名，给浏览器的「团队」页签提供 manage 方法。
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Service } from '@deepseek-ai/cordis';
import { credentialKey } from '@deepseek-ai/dsh-credentials';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { bindTypertRemote, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import manifest from '../package.json' with { type: 'json' };
import { featureId, packageName } from '../identity.js';
import { contract, input, namespace } from './contract.js';
import { Engine } from './engine.js';
import { approvalReason, teamWorkTool, TOOL_NAME } from './tool.js';
import tabIcon from './tab-icon.svg';

const LABEL = { zh: '团队', en: 'Team' };
// 要鲸翼个人版公开的三样接口：专家来源、知识来源（0.2.1-rc.5.2 起）和助手名称（0.2.1-rc.5.4 起）。
const NEED = '0.2.1-rc.5.4';

export default class WhalewingEnterprise extends Service {
  static inject = ['whalewing', 'typert', 'credentials', 'profileContext'];

  constructor(ctx) {
    super(ctx, namespace);
    const profile = ctx.profileContext?.dir;
    if (typeof profile !== 'string' || !path.isAbsolute(profile)) throw new Error('拿不到当前 DSH profile 的位置，鲸翼企业版没法放本机缓存');
    if (typeof ctx.whalewing.experts?.registerSource !== 'function' || typeof ctx.whalewing.knowledge?.registerSource !== 'function'
      || typeof ctx.whalewing.assistant?.registerName !== 'function') {
      throw new Error(`鲸翼个人版太旧，没有鲸翼企业版要用的接口（团队内容、助手名称）。请先把鲸翼升级到 ${NEED} 或更新，再启用鲸翼企业版`);
    }
    // 每个 profile 各有一份登录和缓存，测试用的 profile 不会和正式的混在一起。
    const profileId = createHash('sha256').update(path.resolve(profile)).digest('hex').slice(0, 12);
    const log = message => console.warn(`[鲸翼企业版] ${message}`);
    this.engine = new Engine({
      baseDir: path.join(profile, 'whalewing-enterprise'),
      credentials: ctx.credentials,
      credentialKey: credentialKey('dsh-whalewing-enterprise', `session-${profileId}`),
      personal: ctx.whalewing.knowledge,
      // 企业设置里起了助手名称就交给鲸翼；要在 features.register 之后、用同一个 ctx 调：Engine 读完本机状态才调，那时已经登记过了。
      assistant: { register: name => ctx.whalewing.assistant.registerName(ctx, name) },
      version: manifest.version,
      onChange: () => this.publish(),
      log,
    });

    ctx.whalewing.features.register(ctx, {
      id: featureId, api: 1, package: packageName,
      skills: [this.engine.skillsDir],
      tab: { placement: 'end', keepAlive: true, icon: tabIcon },
    });
    this.experts = ctx.whalewing.experts.registerSource(ctx, {
      label: LABEL,
      save: (request, options) => this.engine.saveExpert(request, options),
    });
    ctx.whalewing.knowledge.registerSource(ctx, {
      label: LABEL,
      search: (query, options) => this.engine.searchKnowledge(query, options),
      read: (notePath, options) => this.engine.readKnowledge(notePath, options),
    });

    this.typertRemote = bindTypertRemote(this, namespace, { namespace });
    ctx.typert.register(contract.host);

    // 模型工具 team_work：插件自己登记的工具，小鲸和所有专家都能用（个人版只在专家会话里隐藏没绑定的 MCP 工具）。
    // 写操作走 DSH 原生审批：员工点同意才发出；没有审批服务或会话关了审批，就不改。
    ctx.inject(['tools'], scope => {
      const approve = async ({ summary, exec }) => {
        const approval = scope.get('approval');
        if (!approval || !exec.agent) return 'unavailable';
        return approval.request({ agent: exec.agent, toolName: TOOL_NAME, callId: exec.callId, ...approvalReason(summary), ...(exec.signal ? { signal: exec.signal } : {}) });
      };
      scope.tools.register(defineTool(teamWorkTool({ engine: this.engine, approve })));
    });
    ctx.effect(() => () => this.engine.close());
    this.engine.start().catch(error => log(`启动失败：${error.message}`));
  }

  publish() {
    try { this.experts.set(this.engine.expertItems()); }
    catch (error) { if (error.code !== 'FEATURE_CLOSED') console.warn(`[鲸翼企业版] 更新团队专家失败：${error.message}`); }
  }

  async manage(raw, signal) {
    try { return await this.engine.manage(input.parse(raw), signal); }
    catch (error) {
      const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(error.code) ? error.code : error.name === 'ZodError' ? 'INVALID_INPUT' : 'ERROR';
      throw new RemoteError(code, error.message, {});
    }
  }
}
