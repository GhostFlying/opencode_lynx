// Copyright 2025 The OpenCode Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import <Lynx/LynxUI.h>

/// Custom Lynx element that renders SVG content.
///
/// Usage in JSX:
///   <svg content="<svg ...>...</svg>" style={{ width: 20, height: 20 }} />
///
/// Props:
///   - content: Raw SVG XML string
///   - src:     URL to an SVG file (not yet implemented)
@interface LynxUISvg : LynxUI <UIImageView *>

@end
