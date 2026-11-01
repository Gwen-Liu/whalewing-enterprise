import manifest from './package.json' with { type: 'json' };

// 包名和功能身份只有此包声明一处输入；Host、Client 与 patch 均从这里派生。
if (!/^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(manifest.name)
  || !/^[a-z][a-z0-9-]{0,79}$/.test(manifest.whalewingExtension?.id)) throw new Error('请先在 package.json 填写合法包名和 whalewingExtension.id');
export const packageName = manifest.name;
export const featureId = manifest.whalewingExtension.id;
export const rowId = packageName.replace(/^@/, '').replaceAll('/', '-').replace(/^dsh-/, '');
