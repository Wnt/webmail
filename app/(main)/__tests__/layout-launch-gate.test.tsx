// Fork (Wnt/webmail): the iPhone launch images show the shipped icon, so the
// root layout links them only for a deployment that turns them on
// (PWA_LAUNCH_IMAGES=true, lib/pwa-launch.ts), never in the static Lite build.
// From the review of perf/pwa-start (r3 N3).
import {describe,it,expect,vi,afterEach} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
const state=vi.hoisted(()=>({lite:false}));
vi.mock('@/lib/lite',()=>({get IS_LITE(){return state.lite},LITE_MOUNT_GLOBAL:'__TEST_MOUNT__'}));
vi.mock('next/font/google',()=>({Geist:()=>({variable:'sans'}),Geist_Mono:()=>({variable:'mono'}),Hanken_Grotesk:()=>({variable:'hanken'})}));
vi.mock('next/headers',()=>({headers:async()=>new Headers({'x-pathname':'/en/mail/','host':'mail.example.test'})}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async()=>((k:string)=>k)}));
vi.mock('@/lib/admin/config-manager',()=>({configManager:{ensureLoaded:async()=>{},get:(_k:string,f:unknown)=>f,getAllWithSources:()=>({pwaThemeColor:{source:'default'}})}}));
vi.mock('@/components/service-worker-registration',()=>({ServiceWorkerRegistration:()=>null}));
vi.mock('@/components/start-marks',()=>({StartMarks:()=>null}));
vi.mock('@/components/favicon-badge',()=>({FaviconBadge:()=>null}));
vi.mock('@/components/theme-color-sync',()=>({ThemeColorSync:()=>null}));
vi.mock('../../globals.css', () => ({}));
import Layout from '@/app/(main)/layout';
afterEach(()=>vi.unstubAllEnvs());
describe('runtime launch image gate',()=>{
 it.each([undefined,'false','TRUE','1'])('omits links for %s',async(value)=>{state.lite=false;vi.stubEnv('PWA_LAUNCH_IMAGES',value);expect(renderToStaticMarkup(await Layout({children:null}))).not.toContain('apple-touch-startup-image');});
 it('includes 24 links only for true, with the mount prefix',async()=>{state.lite=false;vi.stubEnv('PWA_LAUNCH_IMAGES','true');vi.stubEnv('NEXT_PUBLIC_BASE_PATH','/webmail/');const html=renderToStaticMarkup(await Layout({children:null}));expect(html.match(/rel="apple-touch-startup-image"/g)).toHaveLength(24);expect(html).toContain('href="/webmail/branding/launch/');});
 it('omits them in Lite even when enabled',async()=>{state.lite=true;vi.stubEnv('PWA_LAUNCH_IMAGES','true');expect(renderToStaticMarkup(await Layout({children:null}))).not.toContain('apple-touch-startup-image');});
});
