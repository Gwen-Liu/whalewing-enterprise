// DSH Host 入口：登记鲸翼扩展、接上专家来源和知识来源，给浏览器的「团队」页签提供 manage 方法。
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Service } from '@deepseek-ai/cordis';
import { credentialKey } from '@deepseek-ai/dsh-credentials';
import { bindTypertRemote, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import manifest from '../package.json' with { type: 'json' };
import { featureId, packageName } from '../identity.js';
import { contract, input, namespace } from './contract.js';
import { Engine } from './engine.js';
import tabIcon from './tab-icon.svg';

const LABEL = { zh: '团队', en: 'Team' };
const NEED = '0.2.1-rc.5.2';

export default class WhalewingEnterprise extends Service {
  static inject = ['whalewing', 'typert', 'credentials', 'profileContext'];

  constructor(ctx) {
    super(ctx, namespace);
    const profile = ctx.profileContext?.dir;
    if (typeof profile !== 'string' || !path.isAbsolute(profile)) throw new Error('拿不到当前 DSH profile 的位置，鲸翼企业版没法放本机缓存');
    if (typeof ctx.whalewing.experts?.registerSource !== 'function' || typeof ctx.whalewing.knowledge?.registerSource !== 'function') {
      throw new Error(`鲸翼个人版太旧，没有团队内容要用的接口。请先把鲸翼升级到 ${NEED} 或更新，再启用鲸翼企业版`);
    }
    // 每个 profile 各有一份登录和缓存，测试用的 profile 不会和正式的混在一起。
    const profileId = createHash('sha256').update(path.resolve(profile)).digest('hex').slice(0, 12);
    const log = message => console.warn(`[鲸翼企业版] ${message}`);
    this.engine = new Engine({
      baseDir: path.join(profile, 'whalewing-enterprise'),
      credentials: ctx.credentials,
      credentialKey: credentialKey('dsh-whalewing-enterprise', `session-${profileId}`),
      personal: ctx.whalewing.knowledge,
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
