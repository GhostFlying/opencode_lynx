// @ts-nocheck
import { defineConfig } from '@lynx-js/rspeedy'
import { pluginQRCode } from '@lynx-js/qrcode-rsbuild-plugin'
import { pluginReactLynx } from '@lynx-js/react-rsbuild-plugin'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  source: {
    entry: {
      main: './src/pages/main/index.tsx',
      second: './src/pages/second/index.tsx',
      chat: './src/pages/chat/index.tsx',
    },
  },
  output: {
    assetPrefix: 'asset:///',
    filename: {
      bundle: '[name].lynx.bundle'
    },
  },
  tools: {
    rspack(config, { appendPlugins, rspack }) {
      config.resolve ??= {}
      config.resolve.alias ??= {}

      // On the Lynx main thread (Lepus/QuickJS), only UI rendering runs.
      // The opencode gateway imports @opencode-ai/sdk which references Web APIs
      // (Headers, Response) at module scope — absent on the main thread.
      // Replace the gateway with a lightweight stub for the main-thread layer.
      const gatewayReal = fileURLToPath(new URL('./src/opencode/gateway.ts', import.meta.url))
      const gatewayStub = fileURLToPath(new URL('./src/opencode/gateway.main-stub.ts', import.meta.url))

      config.module ??= {}
      config.module.rules ??= []
      config.module.rules.push({
        issuerLayer: 'react:main-thread',
        resolve: {
          alias: {
            [gatewayReal]: gatewayStub,
          },
        },
      })

      return config
    },
  },
  plugins: [
    pluginQRCode({
      schema(url: string): string {
        // We use `?fullscreen=true` to open the page in LynxExplorer in full screen mode
        return `${url}?fullscreen=true`
      },
    }),
    pluginReactLynx({
      enableCSSInheritance: true,
    }),
  ],
})
