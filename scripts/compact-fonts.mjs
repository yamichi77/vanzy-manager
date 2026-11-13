/** Retain WOFF2 for supported modern browsers/Tauri, omit duplicate legacy WOFF.
 * Operates only on proven fallback URLs in generated dist/assets CSS.
 */
import { readdir,readFile,writeFile,unlink } from 'node:fs/promises';
import path from 'node:path';
const assets=new URL('../dist/assets/',import.meta.url);
const names=await readdir(assets);const removed=new Set();const updates=[];
for(const name of names.filter(x=>x.endsWith('.css'))){
 const source=await readFile(new URL(name,assets),'utf8');
 const next=source.replace(/,\s*url\(([^)]*\.woff)\)\s*format\(["']woff["']\)/g,(_match,url)=>{
  const file=path.posix.basename(url);
  if(!names.includes(file)||!file.endsWith('.woff'))throw new Error('Unexpected font fallback: '+url);
  removed.add(file);return '';
 });
 if(/url\([^)]*\.woff\)/.test(next))throw new Error('Unrecognized legacy WOFF reference; no files removed.');
 updates.push([name,next]);
}
for(const [name,content] of updates)await writeFile(new URL(name,assets),content);
for(const name of removed)await unlink(new URL(name,assets));
console.log(`Kept WOFF2; omitted ${removed.size} duplicate legacy WOFF files.`);
