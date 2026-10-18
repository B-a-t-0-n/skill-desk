import {packager} from '@electron/packager';
import path from 'node:path';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=process.env.SKILL_DESK_BUILD_OUT || path.join(root,'release');
const electronZipDir=process.env.SKILL_DESK_ELECTRON_ZIP_DIR;
const metadata=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const paths=await packager({
  dir:root,name:'SkillDesk',platform:'win32',arch:'x64',electronVersion:'44.7.0',
  out,overwrite:true,asar:true,prune:false,...(electronZipDir ? {electronZipDir} : {}),
  icon:path.join(root,'assets/icon.ico'),
  ignore:[/^\/(?:node_modules|tests|scripts|release|test-results)(?:\/|$)/,/\.log$/,/^\/pnpm-lock\.yaml$/,/^\/\.git/],
  win32metadata:{ProductName:'Skill Desk',FileDescription:'Skill Desk — Codex session monitor',InternalName:'SkillDesk',OriginalFilename:'SkillDesk.exe'},
  appVersion:metadata.version,buildVersion:metadata.version,
});
for(const folder of paths){
  await fs.copyFile(path.join(root,'README.md'),path.join(folder,'Прочитай меня.md'));
  console.log('Packaged:',folder);
}
