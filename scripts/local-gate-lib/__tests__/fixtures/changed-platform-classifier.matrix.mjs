/** @type {{
 *  name: string,
 *  changes: Array<{ status: string, path?: string, fromPath?: string, toPath?: string }>,
 *  expected: 'ios' | 'android' | 'both'
 * }[]} */
const matrix = [
  {
    name: 'shared lynx app code change forces both',
    changes: [{ status: 'M', path: 'src/pages/main/App.tsx' }],
    expected: 'both',
  },
  {
    name: 'ios-only modify maps to ios',
    changes: [{ status: 'M', path: 'ios/OpenCodeLynx/AppDelegate.swift' }],
    expected: 'ios',
  },
  {
    name: 'android-only add maps to android',
    changes: [{ status: 'A', path: 'android/app/src/main/java/com/example/NewFile.kt' }],
    expected: 'android',
  },
  {
    name: 'shared app config forces both',
    changes: [{ status: 'M', path: 'app.config.ts' }],
    expected: 'both',
  },
  {
    name: 'unknown path fail-closed to both',
    changes: [{ status: 'M', path: 'docs/random-notes.md' }],
    expected: 'both',
  },
  {
    name: 'rename within ios stays ios',
    changes: [{
      status: 'R100',
      fromPath: 'ios/OpenCodeLynx/OldService.swift',
      toPath: 'ios/OpenCodeLynx/NewService.swift',
    }],
    expected: 'ios',
  },
  {
    name: 'rename across ios to android becomes both',
    changes: [{
      status: 'R090',
      fromPath: 'ios/OpenCodeLynx/Bridge.swift',
      toPath: 'android/app/src/main/java/com/example/Bridge.kt',
    }],
    expected: 'both',
  },
  {
    name: 'delete android file maps to android',
    changes: [{ status: 'D', path: 'android/app/src/main/java/com/example/Obsolete.kt' }],
    expected: 'android',
  },
  {
    name: 'mixed ios and android changes map to both',
    changes: [
      { status: 'M', path: 'ios/OpenCodeLynx/Foo.swift' },
      { status: 'M', path: 'android/app/src/main/java/com/example/Foo.kt' },
    ],
    expected: 'both',
  },
  {
    name: 'shared resource path forces both',
    changes: [{ status: 'A', path: 'resource/images/icon.png' }],
    expected: 'both',
  },
]

export default matrix
