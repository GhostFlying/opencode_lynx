// Copyright 2025 The OpenCode Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.
import { defineConfig, mergeConfig } from 'vitest/config'
import { createVitestConfig } from '@lynx-js/react/testing-library/vitest-config'
import { fileURLToPath } from 'node:url'

const defaultConfig = await createVitestConfig()
const opencodeSdkRoot = fileURLToPath(new URL('./node_modules/@opencode-ai/sdk/dist/index.js', import.meta.url))
const reactUseRoot = fileURLToPath(new URL('./node_modules/.pnpm/node_modules/react-use/', import.meta.url))
const lynxUiShimPath = fileURLToPath(new URL('./src/test-support/lynx-ui-shim.tsx', import.meta.url))
const config = defineConfig({
  resolve: {
    alias: [
      { find: /^@opencode-ai\/sdk$/, replacement: opencodeSdkRoot },
      { find: /^@lynx-js\/lynx-ui$/, replacement: lynxUiShimPath },
      { find: /^react-use\/(.*)$/, replacement: `${reactUseRoot}$1.js` },
    ],
  },
  test: {
    server: {
      deps: {
        inline: ['@lynx-js/react-use', 'react-use'],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'lcov', 'html'],
      exclude: [
        'node_modules/**',
        'dist/**',
        'vitest.config.ts',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData/**',
        '**/tests/**'
      ]
    }
  },
})

export default mergeConfig(defaultConfig, config)
