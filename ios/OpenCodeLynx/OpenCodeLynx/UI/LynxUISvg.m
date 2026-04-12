// Copyright 2025 The OpenCode Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import "LynxUISvg.h"
#import "OpenCodeSVGRenderer.h"
#import <Lynx/LynxComponentRegistry.h>
#import <Lynx/LynxPropsProcessor.h>

@implementation LynxUISvg

LYNX_REGISTER_UI("svg")

- (UIImageView *)createView {
  UIImageView *imageView = [[UIImageView alloc] init];
  imageView.contentMode = UIViewContentModeScaleAspectFit;
  imageView.clipsToBounds = YES;
  return imageView;
}

LYNX_PROP_SETTER("content", setContent, NSString *) {
  self.view.image = OpenCodeRenderSVGContent(value);
}

@end
