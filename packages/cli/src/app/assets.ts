import html from './ui/index.html' with { type: 'text' };
import css from './ui/app.css' with { type: 'text' };
import client from './ui/client.js' with { type: 'text' };
/** Text imports are embedded by Bun; no runtime source checkout or asset server. */
export const appAssets = {
 '/': {body:html as unknown as string,type:'text/html; charset=utf-8'},
 '/app/assets/app.css': {body:css,type:'text/css; charset=utf-8'},
 '/app/assets/client.js': {body:client,type:'text/javascript; charset=utf-8'},
};
