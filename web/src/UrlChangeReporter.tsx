import { useEffect } from 'react';

const DEFAULT_PARENT_ORIGIN = '*';
const MESSAGE_TYPE = 'URL_CHANGE';

function getParentOrigin() {
  if (typeof document === 'undefined' || !document.referrer) {
    return DEFAULT_PARENT_ORIGIN;
  }

  try {
    const referrerOrigin = new URL(document.referrer).origin;
    if (typeof window !== 'undefined' && referrerOrigin === window.location.origin) {
      return DEFAULT_PARENT_ORIGIN;
    }
    return referrerOrigin;
  } catch {
    return DEFAULT_PARENT_ORIGIN;
  }
}

function buildParentCompatibleUrl() {
  const { origin, pathname, search, hash } = window.location;
  const normalizedPath = pathname === '/' ? '/' : pathname.replace(/\/+$/, '');
  const hashPath = normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`;
  return `${origin}/#${hashPath}${search}${hash}`;
}

function normalizeHashRoute() {
  const { pathname, hash, search } = window.location;

  if (pathname !== '/' || !hash.startsWith('#/')) {
    return false;
  }

  const hashContent = hash.slice(1);
  const [hashPath = '/', hashQuery = ''] = hashContent.split('?');
  const normalizedPath = hashPath.startsWith('/') ? hashPath : `/${hashPath}`;
  const params = new URLSearchParams(hashQuery);

  if (search) {
    const currentParams = new URLSearchParams(search.slice(1));
    currentParams.forEach((value, key) => {
      if (!params.has(key)) {
        params.set(key, value);
      }
    });
  }

  const nextSearch = params.toString();
  const nextUrl = `${normalizedPath}${nextSearch ? `?${nextSearch}` : ''}`;
  window.location.replace(nextUrl);
  return true;
}

const UrlChangeReporter = () => {
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (normalizeHashRoute()) {
      return;
    }

    if (window.parent === window) {
      return;
    }

    const parentOrigin = getParentOrigin();

    let lastReportedUrl = '';

    const report = () => {
      const currentUrl = buildParentCompatibleUrl();

      if (currentUrl === lastReportedUrl) {
        return;
      }

      lastReportedUrl = currentUrl;
      window.parent.postMessage(
        {
          type: MESSAGE_TYPE,
          source: 'iteam',
          url: currentUrl,
          actualUrl: window.location.href,
          pathname: window.location.pathname,
          search: window.location.search,
          hash: window.location.hash,
        },
        parentOrigin
      );
    };

    const originalPushState = window.history.pushState;
    const originalReplaceState = window.history.replaceState;

    const patchedPushState: History['pushState'] = function pushState(...args) {
      originalPushState.apply(this, args);
      report();
    };

    const patchedReplaceState: History['replaceState'] = function replaceState(...args) {
      originalReplaceState.apply(this, args);
      report();
    };

    window.history.pushState = patchedPushState;
    window.history.replaceState = patchedReplaceState;

    const handleLocationChange = () => report();

    report();
    window.setTimeout(report, 0);
    window.addEventListener('hashchange', handleLocationChange);
    window.addEventListener('popstate', handleLocationChange);
    window.addEventListener('pageshow', handleLocationChange);

    return () => {
      if (window.history.pushState === patchedPushState) {
        window.history.pushState = originalPushState;
      }
      if (window.history.replaceState === patchedReplaceState) {
        window.history.replaceState = originalReplaceState;
      }
      window.removeEventListener('hashchange', handleLocationChange);
      window.removeEventListener('popstate', handleLocationChange);
      window.removeEventListener('pageshow', handleLocationChange);
    };
  }, []);

  return null;
};

export default UrlChangeReporter;
