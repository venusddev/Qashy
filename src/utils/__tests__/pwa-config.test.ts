import workboxConfigValue from '../../../workbox-config.cjs';

const workboxConfig = workboxConfigValue as {
  clientsClaim: boolean;
  skipWaiting: boolean;
  runtimeCaching: unknown[];
};

describe('PWA configuration', () => {
  it('lets an activated update control existing clients without caching finance data', () => {
    expect(workboxConfig.clientsClaim).toBe(true);
    expect(workboxConfig.skipWaiting).toBe(false);
    expect(workboxConfig.runtimeCaching).toEqual([]);
  });
});
