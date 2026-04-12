// Copyright 2025 The OpenCode Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import <Lynx/LynxComponentRegistry.h>
#import <Lynx/LynxPropsProcessor.h>
#import <Lynx/LynxUI.h>
#import <UIKit/UIGlassEffect.h>

static CGFloat OpenCodeParseLength(NSString *value, CGFloat fallback) {
  if (![value isKindOfClass:[NSString class]] || value.length == 0) {
    return fallback;
  }

  NSString *trimmed = [value stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if (trimmed.length == 0) {
    return fallback;
  }

  NSString *numeric = [trimmed hasSuffix:@"px"] ? [trimmed substringToIndex:trimmed.length - 2] : trimmed;
  CGFloat parsed = (CGFloat)[numeric doubleValue];
  if (parsed <= 0) {
    return fallback;
  }
  return parsed;
}

@interface OpenCodeLiquidGlassView : UIView
@property(nonatomic, strong) UIVisualEffectView *effectView;
@property(nonatomic, strong) UIView *tintView;
@property(nonatomic, copy) NSString *variant;
@property(nonatomic, assign) CGFloat glassCornerRadius;
@property(nonatomic, assign) CGFloat tintAlpha;
@end

@implementation OpenCodeLiquidGlassView

- (instancetype)initWithFrame:(CGRect)frame {
  if (self = [super initWithFrame:frame]) {
    self.userInteractionEnabled = NO;
    self.backgroundColor = UIColor.clearColor;
    self.clipsToBounds = YES;
    self.glassCornerRadius = 24.f;
    self.tintAlpha = 0.18f;
    self.variant = @"bar";

    UIBlurEffect *effect;
    if (@available(iOS 13.0, *)) {
      effect = [UIBlurEffect effectWithStyle:UIBlurEffectStyleSystemUltraThinMaterialLight];
    } else {
      effect = [UIBlurEffect effectWithStyle:UIBlurEffectStyleExtraLight];
    }

    _effectView = [[UIVisualEffectView alloc] initWithEffect:effect];
    _effectView.userInteractionEnabled = NO;
    _effectView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    [self addSubview:_effectView];

    _tintView = [[UIView alloc] initWithFrame:CGRectZero];
    _tintView.userInteractionEnabled = NO;
    _tintView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    [self addSubview:_tintView];

    [self updateAppearance];
  }
  return self;
}

- (void)layoutSubviews {
  [super layoutSubviews];
  self.effectView.frame = self.bounds;
  self.tintView.frame = self.bounds;

  CGFloat radius = self.glassCornerRadius > 0 ? self.glassCornerRadius : self.layer.cornerRadius;
  self.layer.cornerRadius = radius;
  self.effectView.layer.cornerRadius = radius;
  self.effectView.clipsToBounds = YES;
  self.tintView.layer.cornerRadius = radius;
  self.tintView.clipsToBounds = YES;
}

- (void)setVariant:(NSString *)variant {
  _variant = [variant copy];
  [self updateAppearance];
}

- (void)setTintAlpha:(CGFloat)tintAlpha {
  _tintAlpha = MAX(0.f, MIN(1.f, tintAlpha));
  [self updateAppearance];
}

- (void)setGlassCornerRadius:(CGFloat)glassCornerRadius {
  _glassCornerRadius = MAX(0.f, glassCornerRadius);
  [self setNeedsLayout];
}

- (void)updateAppearance {
  if (@available(iOS 26.0, *)) {
    UIGlassEffectStyle style =
        [self.variant isEqualToString:@"card"] ? UIGlassEffectStyleRegular : UIGlassEffectStyleClear;
    UIGlassEffect *effect = [UIGlassEffect effectWithStyle:style];
    effect.interactive = NO;
    effect.tintColor = [self.variant isEqualToString:@"card"]
                           ? [UIColor colorWithWhite:1.f alpha:MAX(0.02f, self.tintAlpha * 0.35f)]
                           : [UIColor colorWithWhite:1.f alpha:MAX(0.01f, self.tintAlpha * 0.18f)];
    self.effectView.effect = effect;
    self.tintView.backgroundColor = UIColor.clearColor;
    return;
  }

  if (@available(iOS 13.0, *)) {
    UIBlurEffectStyle style = UIBlurEffectStyleSystemUltraThinMaterialLight;
    if ([self.variant isEqualToString:@"card"]) {
      style = UIBlurEffectStyleSystemThinMaterialLight;
    }
    self.effectView.effect = [UIBlurEffect effectWithStyle:style];
  } else {
    self.effectView.effect = [UIBlurEffect effectWithStyle:UIBlurEffectStyleExtraLight];
  }

  UIColor *tintColor = [self.variant isEqualToString:@"card"]
                           ? [UIColor colorWithRed:1.f green:0.99f blue:0.97f alpha:self.tintAlpha + 0.04f]
                           : [UIColor colorWithRed:1.f green:0.98f blue:0.95f alpha:self.tintAlpha];
  self.tintView.backgroundColor = tintColor;
}

@end

@interface LynxUILiquidGlass : LynxUI <OpenCodeLiquidGlassView *>
@end

@implementation LynxUILiquidGlass

LYNX_REGISTER_UI("x-liquid-glass")

- (OpenCodeLiquidGlassView *)createView {
  return [[OpenCodeLiquidGlassView alloc] initWithFrame:CGRectZero];
}

LYNX_PROP_SETTER("variant", setVariant, NSString *) {
  self.view.variant = value;
}

LYNX_PROP_SETTER("corner-radius", setCornerRadius, NSString *) {
  self.view.glassCornerRadius = OpenCodeParseLength(value, 24.f);
}

LYNX_PROP_SETTER("tint-alpha", setTintAlpha, NSString *) {
  self.view.tintAlpha = MAX(0.f, MIN(1.f, (CGFloat)[value doubleValue]));
}

@end
