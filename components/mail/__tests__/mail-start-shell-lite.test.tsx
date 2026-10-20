import React, { Suspense, lazy } from 'react';
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';

// Fork (Wnt/webmail): the static Lite export renders MailApp's start shell
// with no route segments (the list outline); in the browser its hook reads the
// message or thread link, direct or parked. The first render must still match
// the exported markup (no hydration error) and keep the link. From the review
// of perf/pwa-start (r1 R4, r3 N3). The mocks are the notification-tap
// specs' (components/mail/__tests__).
vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
vi.mock('@/components/email/email-composer', () => ({ EmailComposer: () => null }));
vi.mock('@/components/email/email-viewer', () => ({ EmailViewer: () => null }));
vi.mock('@/components/layout/sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/calendar-event-notification-toaster', () => ({ CalendarEventNotificationToaster: () => null }));
vi.mock('@/components/layout/share-notification-toaster', () => ({ ShareNotificationToaster: () => null }));
vi.mock('@/components/layout/mobile-header', () => ({ MobileHeader: () => null }));
vi.mock('@/components/email/message-list-tabs', () => ({ MessageListTabs: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => null }));
vi.mock('@/components/tour/tour-provider', () => ({ useTour: () => ({ activeTour: null, registerStep: vi.fn() }) }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail' }) }));
vi.mock('@/hooks/use-identity-sync', () => ({ useIdentitySync: () => {} }));
vi.mock('@/hooks/use-pro-multi-account-identities', () => ({ useProMultiAccountIdentities: () => [] }));
vi.mock('@/hooks/use-pro-multi-account-mailboxes', () => ({ useProMultiAccountMailboxes: () => {} }));
vi.mock('@/hooks/use-wopi-status', () => ({ useWopiStatus: () => null, canWopiOpen: () => false }));
vi.mock('@/hooks/use-browser-navigation', () => ({ useBrowserNavigation: () => {} }));
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: true, isTablet: false, isDesktop: false }),
  useMediaQuery: () => false,
  useIsDesktop: () => false,
}));
vi.mock('@/lib/push-bindings', () => ({ reconcilePushBindings: () => {}, releasePushBindings: () => {} }));
vi.mock('@/components/email/email-list', () => ({ EmailList: () => <div>message list</div> }));
vi.mock('@/components/ui/welcome-banner', () => ({ WelcomeBanner: () => null }));


import {renderToString} from 'react-dom/server';
import {hydrateRoot} from 'react-dom/client';
vi.mock('@/lib/lite',async(importOriginal)=>({...await importOriginal<typeof import('@/lib/lite')>(),IS_LITE:true}));
const {MailApp}=await import('@/components/mail/mail-app');
const {stashPendingLitePath}=await import('@/lib/lite-link-segments');
beforeEach(()=>{
 sessionStorage.clear();
 vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('No network')));
 useAuthStore.setState({isAuthenticated:false,isLoading:true,client:null,checkAuth:()=>new Promise<void>(()=>{})});
 usePluginStore.setState({initializePlugins:vi.fn().mockResolvedValue(undefined)});
 useThemeStore.setState({syncServerThemes:vi.fn().mockResolvedValue(undefined)});
});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('Lite real MailApp hydration',()=>{
 it.each([['message',false],['message',true],['thread',false],['thread',true]] as const)('%s parked=%s',async(kind,parked)=>{
  const win=window;
  vi.stubGlobal('window',undefined);
  let html:string;try{html=renderToString(<MailApp linkSegments={[]} />);}finally{vi.stubGlobal('window',win);}
  expect(html).toContain('data-mm-start-shell');
  const target='/en/mail/'+kind+'/fixture-id';
  window.history.replaceState({},'',parked?'/en/mail/':target);
  if(parked)expect(stashPendingLitePath(target)).toBe(true);
  const el=document.createElement('div');el.innerHTML=html;document.body.appendChild(el);
  const errors:unknown[]=[];let root:ReturnType<typeof hydrateRoot>;
  try{await act(async()=>{root=hydrateRoot(el,<MailApp linkSegments={[]} />,{onRecoverableError:e=>errors.push(e)});await new Promise(r=>setTimeout(r,20));});expect(errors).toEqual([]);expect(window.location.pathname).toBe(target);expect(el.querySelector('[data-mm-start-shell]')).not.toBeNull();}
  finally{await act(async()=>root?.unmount());el.remove();}
 });
});
