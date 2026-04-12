// Copyright 2025 The OpenCode Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import "OpenCodeSVGRenderer.h"
#import <Lynx/LynxComponentRegistry.h>
#import <Lynx/LynxEventEmitter.h>
#import <Lynx/LynxPropsProcessor.h>
#import <Lynx/LynxUI.h>
#import <Lynx/LynxUIOwner.h>

static NSString *OpenCodeTabBarIconSVG(NSString *name) {
  if ([name isEqualToString:@"settings"]) {
    return @"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"22\" height=\"22\" viewBox=\"0 0 22 22\" fill=\"none\"><path d=\"M9.79175 4.81259C10.4475 3.74096 11.5527 3.74096 12.2084 4.81259L12.4927 5.27722C12.7462 5.69171 13.2867 5.89374 13.7561 5.7598L14.2822 5.60961C15.4955 5.2632 16.2769 6.04458 15.9305 7.25791L15.7803 7.78401C15.6463 8.25346 15.8484 8.79395 16.2629 9.04747L16.7275 9.33171C17.7991 9.98748 17.7991 11.0927 16.7275 11.7484L16.2629 12.0327C15.8484 12.2862 15.6463 12.8267 15.7803 13.2961L15.9305 13.8222C16.2769 15.0356 15.4955 15.8169 14.2822 15.4705L13.7561 15.3203C13.2867 15.1864 12.7462 15.3884 12.4927 15.8029L12.2084 16.2675C11.5527 17.3392 10.4475 17.3392 9.79175 16.2675L9.50751 15.8029C9.25399 15.3884 8.71349 15.1864 8.24405 15.3203L7.71795 15.4705C6.50462 15.8169 5.72325 15.0356 6.06966 13.8222L6.21984 13.2961C6.35379 12.8267 6.15175 12.2862 5.73726 12.0327L5.27262 11.7484C4.201 11.0927 4.201 9.98748 5.27262 9.33171L5.73726 9.04747C6.15175 8.79395 6.35379 8.25346 6.21984 7.78401L6.06966 7.25791C5.72325 6.04458 6.50462 5.2632 7.71795 5.60961L8.24405 5.7598C8.71349 5.89374 9.25399 5.69171 9.50751 5.27722L9.79175 4.81259Z\" stroke=\"#000000\" stroke-width=\"1.45\"/><path d=\"M11.0001 12.8333C12.0126 12.8333 12.8334 12.0125 12.8334 11C12.8334 9.98748 12.0126 9.16667 11.0001 9.16667C9.98756 9.16667 9.16675 9.98748 9.16675 11C9.16675 12.0125 9.98756 12.8333 11.0001 12.8333Z\" stroke=\"#000000\" stroke-width=\"1.45\"/></svg>";
  }

  return @"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"22\" height=\"22\" viewBox=\"0 0 22 22\" fill=\"none\"><path d=\"M5.04175 6.41667C5.04175 5.65728 5.65736 5.04167 6.41675 5.04167H15.5834C16.3428 5.04167 16.9584 5.65728 16.9584 6.41667V12.8333C16.9584 13.5927 16.3428 14.2083 15.5834 14.2083H10.0875L7.10964 16.4429C6.65593 16.7832 6.00008 16.4594 6.00008 15.8922V14.2083H6.41675C5.65736 14.2083 5.04175 13.5927 5.04175 12.8333V6.41667Z\" stroke=\"#000000\" stroke-width=\"1.6\" stroke-linejoin=\"round\"/><path d=\"M8.25008 8.25H13.7501\" stroke=\"#000000\" stroke-width=\"1.6\" stroke-linecap=\"round\"/><path d=\"M8.25008 10.5417H12.3751\" stroke=\"#000000\" stroke-width=\"1.6\" stroke-linecap=\"round\"/></svg>";
}

static UIImage *OpenCodeTabBarIcon(NSString *name) {
  UIImage *image = OpenCodeRenderSVGContent(OpenCodeTabBarIconSVG(name));
  return [image imageWithRenderingMode:UIImageRenderingModeAlwaysTemplate];
}

@interface OpenCodeNativeTabItemView : UIView
@property(nonatomic, strong) UIView *backgroundView;
@property(nonatomic, strong) UIImageView *iconView;
@property(nonatomic, strong) UILabel *titleLabel;
@property(nonatomic, copy) NSString *value;
@property(nonatomic, assign, getter=isTabSelected) BOOL tabSelected;
@property(nonatomic, assign, getter=isTabHighlighted) BOOL tabHighlighted;
- (instancetype)initWithValue:(NSString *)value label:(NSString *)label;
- (void)setLabel:(NSString *)label;
@end

@implementation OpenCodeNativeTabItemView

- (instancetype)initWithValue:(NSString *)value label:(NSString *)label {
  if (self = [super initWithFrame:CGRectZero]) {
    self.backgroundColor = UIColor.clearColor;
    self.userInteractionEnabled = NO;
    self.value = value;

    _backgroundView = [[UIView alloc] initWithFrame:CGRectZero];
    _backgroundView.userInteractionEnabled = NO;
    _backgroundView.layer.cornerRadius = 15.f;
    _backgroundView.layer.masksToBounds = YES;
    [self addSubview:_backgroundView];

    _iconView = [[UIImageView alloc] initWithImage:OpenCodeTabBarIcon(value)];
    _iconView.userInteractionEnabled = NO;
    _iconView.contentMode = UIViewContentModeScaleAspectFit;
    [self.backgroundView addSubview:_iconView];

    _titleLabel = [[UILabel alloc] initWithFrame:CGRectZero];
    _titleLabel.userInteractionEnabled = NO;
    _titleLabel.textAlignment = NSTextAlignmentCenter;
    _titleLabel.font = [UIFont systemFontOfSize:13 weight:UIFontWeightHeavy];
    _titleLabel.text = label;
    [self.backgroundView addSubview:_titleLabel];

    [self applyAppearanceAnimated:NO];
  }
  return self;
}

- (void)layoutSubviews {
  [super layoutSubviews];
  self.backgroundView.frame = self.bounds;

  CGFloat iconSize = 20.f;
  CGFloat labelHeight = 16.f;
  CGFloat gap = 4.f;
  CGFloat contentHeight = iconSize + gap + labelHeight;
  CGFloat top = MAX(7.f, floor((CGRectGetHeight(self.bounds) - contentHeight) * 0.5f));
  CGFloat iconX = floor((CGRectGetWidth(self.bounds) - iconSize) * 0.5f);

  self.iconView.frame = CGRectMake(iconX, top, iconSize, iconSize);
  self.titleLabel.frame = CGRectMake(8.f,
                                     CGRectGetMaxY(self.iconView.frame) + gap,
                                     MAX(0.f, CGRectGetWidth(self.bounds) - 16.f),
                                     labelHeight);
  self.layer.shadowPath = [UIBezierPath bezierPathWithRoundedRect:self.bounds cornerRadius:15.f].CGPath;
}

- (void)setTabSelected:(BOOL)tabSelected {
  _tabSelected = tabSelected;
  [self applyAppearanceAnimated:YES];
}

- (void)setTabHighlighted:(BOOL)tabHighlighted {
  _tabHighlighted = tabHighlighted;
  [self applyAppearanceAnimated:YES];
}

- (void)setLabel:(NSString *)label {
  self.titleLabel.text = label;
}

- (void)applyAppearanceAnimated:(BOOL)animated {
  UIColor *iconColor = self.isTabSelected
                           ? UIColor.whiteColor
                           : [UIColor colorWithRed:0.341 green:0.353 blue:0.322 alpha:1.f];
  UIColor *labelColor = iconColor;

  UIColor *fillColor;
  UIColor *borderColor;
  CGFloat shadowOpacity;
  BOOL isHighlighted = self.isTabHighlighted;

  if (self.isTabSelected) {
    fillColor = [UIColor colorWithRed:0.515 green:0.548 blue:0.478 alpha:isHighlighted ? 0.58f : 0.46f];
    borderColor = [UIColor colorWithWhite:1.f alpha:isHighlighted ? 0.12f : 0.16f];
    shadowOpacity = isHighlighted ? 0.04f : 0.07f;
  } else {
    fillColor = [UIColor colorWithWhite:1.f alpha:isHighlighted ? 0.74f : 0.60f];
    borderColor = [UIColor colorWithRed:0.765 green:0.729 blue:0.651 alpha:isHighlighted ? 0.34f : 0.24f];
    shadowOpacity = 0.f;
  }

  void (^changes)(void) = ^{
    self.backgroundView.backgroundColor = fillColor;
    self.backgroundView.layer.borderWidth = 1.f;
    self.backgroundView.layer.borderColor = borderColor.CGColor;
    self.iconView.tintColor = iconColor;
    self.titleLabel.textColor = labelColor;
    self.transform = isHighlighted ? CGAffineTransformMakeScale(0.982f, 0.982f) : CGAffineTransformIdentity;
    self.layer.shadowColor = [UIColor colorWithRed:0.137 green:0.149 blue:0.125 alpha:1.f].CGColor;
    self.layer.shadowOpacity = shadowOpacity;
    self.layer.shadowRadius = 13.f;
    self.layer.shadowOffset = CGSizeMake(0.f, 10.f);
  };

  if (!animated) {
    changes();
    return;
  }

  [UIView animateWithDuration:0.16
                        delay:0
                      options:UIViewAnimationOptionBeginFromCurrentState | UIViewAnimationOptionCurveEaseOut
                   animations:changes
                   completion:nil];
}

@end

@interface OpenCodeNativeTabbarView : UIControl
@property(nonatomic, strong) OpenCodeNativeTabItemView *sessionsButton;
@property(nonatomic, strong) OpenCodeNativeTabItemView *settingsButton;
@property(nonatomic, copy) NSString *selectedValue;
@property(nonatomic, assign) UIEdgeInsets contentPadding;
@property(nonatomic, copy) void (^onSelectionChange)(NSString *value);
@property(nonatomic, copy) NSString *pressedValue;
- (void)setSessionsLabel:(NSString *)label;
- (void)setSettingsLabel:(NSString *)label;
@end

@implementation OpenCodeNativeTabbarView

- (instancetype)initWithFrame:(CGRect)frame {
  if (self = [super initWithFrame:frame]) {
    self.backgroundColor = UIColor.clearColor;
    self.selectedValue = @"sessions";
    self.contentPadding = UIEdgeInsetsZero;
    self.pressedValue = nil;

    _sessionsButton = [[OpenCodeNativeTabItemView alloc] initWithValue:@"sessions" label:@"Sessions"];
    _settingsButton = [[OpenCodeNativeTabItemView alloc] initWithValue:@"settings" label:@"Settings"];

    [self addSubview:_sessionsButton];
    [self addSubview:_settingsButton];
    [self applySelection];
  }
  return self;
}

- (void)layoutSubviews {
  [super layoutSubviews];
  CGRect contentBounds = UIEdgeInsetsInsetRect(self.bounds, self.contentPadding);
  CGFloat spacing = 10.f;
  CGFloat itemWidth = MAX(0.f, (CGRectGetWidth(contentBounds) - spacing) / 2.f);
  self.sessionsButton.frame =
      CGRectMake(CGRectGetMinX(contentBounds), CGRectGetMinY(contentBounds), itemWidth, CGRectGetHeight(contentBounds));
  self.settingsButton.frame =
      CGRectMake(CGRectGetMinX(contentBounds) + itemWidth + spacing,
                 CGRectGetMinY(contentBounds),
                 itemWidth,
                 CGRectGetHeight(contentBounds));
}

- (void)setSelectedValue:(NSString *)selectedValue {
  _selectedValue = [selectedValue isEqualToString:@"settings"] ? @"settings" : @"sessions";
  [self applySelection];
}

- (void)setPressedValue:(NSString *)pressedValue {
  _pressedValue = [pressedValue isEqualToString:@"settings"]
                      ? @"settings"
                      : ([pressedValue isEqualToString:@"sessions"] ? @"sessions" : nil);
  [self applySelection];
}

- (void)setContentPadding:(UIEdgeInsets)contentPadding {
  _contentPadding = contentPadding;
  [self setNeedsLayout];
}

- (void)setSessionsLabel:(NSString *)label {
  [self.sessionsButton setLabel:label];
}

- (void)setSettingsLabel:(NSString *)label {
  [self.settingsButton setLabel:label];
}

- (void)applySelection {
  BOOL sessionsSelected = [self.selectedValue isEqualToString:@"sessions"];
  self.sessionsButton.tabSelected = sessionsSelected;
  self.sessionsButton.tabHighlighted = [self.pressedValue isEqualToString:@"sessions"];
  self.settingsButton.tabSelected = !sessionsSelected;
  self.settingsButton.tabHighlighted = [self.pressedValue isEqualToString:@"settings"];
}

- (NSString *)valueForPoint:(CGPoint)point {
  if (CGRectContainsPoint(self.sessionsButton.frame, point)) {
    return @"sessions";
  }

  if (CGRectContainsPoint(self.settingsButton.frame, point)) {
    return @"settings";
  }

  return nil;
}

- (void)updatePressedValue:(NSString *)pressedValue {
  NSString *normalizedPressedValue = [pressedValue isEqualToString:@"settings"]
                                         ? @"settings"
                                         : ([pressedValue isEqualToString:@"sessions"] ? @"sessions" : nil);
  if ((self.pressedValue == nil && normalizedPressedValue == nil) ||
      [self.pressedValue isEqualToString:normalizedPressedValue]) {
    return;
  }

  _pressedValue = [normalizedPressedValue copy];
  [self applySelection];
}

- (BOOL)beginTrackingWithTouch:(UITouch *)touch withEvent:(UIEvent *)event {
  NSString *pressedValue = [self valueForPoint:[touch locationInView:self]];
  [self updatePressedValue:pressedValue];
  return pressedValue != nil;
}

- (BOOL)continueTrackingWithTouch:(UITouch *)touch withEvent:(UIEvent *)event {
  NSString *pressedValue = [self valueForPoint:[touch locationInView:self]];
  [self updatePressedValue:pressedValue];
  return YES;
}

- (void)endTrackingWithTouch:(UITouch *)touch withEvent:(UIEvent *)event {
  NSString *nextValue = [self valueForPoint:[touch locationInView:self]];
  [self updatePressedValue:nil];
  if (nextValue == nil) {
    return;
  }

  NSLog(@"native_tabbar_ios_tap value=%@ current=%@", nextValue, self.selectedValue);
  if ([nextValue isEqualToString:self.selectedValue]) {
    return;
  }

  self.selectedValue = nextValue;
  NSLog(@"native_tabbar_ios_selected value=%@", nextValue);
  if (self.onSelectionChange != nil) {
    self.onSelectionChange(nextValue);
  }
}

- (void)cancelTrackingWithEvent:(UIEvent *)event {
  [self updatePressedValue:nil];
}

@end

@interface LynxUINativeTabbar : LynxUI <OpenCodeNativeTabbarView *>
@end

@implementation LynxUINativeTabbar

LYNX_REGISTER_UI("x-native-tabbar")

- (OpenCodeNativeTabbarView *)createView {
  OpenCodeNativeTabbarView *view = [[OpenCodeNativeTabbarView alloc] initWithFrame:CGRectZero];
  __weak typeof(self) weakSelf = self;
  view.onSelectionChange = ^(NSString *value) {
    [weakSelf emitChangeEvent:value];
  };
  return view;
}

- (void)layoutDidFinished {
  self.view.contentPadding = self.padding;
}

- (void)emitChangeEvent:(NSString *)value {
  if (self.context.eventEmitter == nil) {
    NSLog(@"native_tabbar_ios_emit_skipped reason=no_event_emitter value=%@", value);
    return;
  }

  NSLog(@"native_tabbar_ios_emit tabchange value=%@ sign=%ld", value, (long)[self sign]);

  LynxCustomEvent *eventInfo =
      [[LynxDetailEvent alloc] initWithName:@"tabchange"
                                 targetSign:[self sign]
                                     detail:@{@"value" : value ?: @"sessions"}];
  [self.context.eventEmitter dispatchCustomEvent:eventInfo];
}

LYNX_PROP_SETTER("selected", setSelected, NSString *) {
  self.view.selectedValue = value;
}

LYNX_PROP_SETTER("pressed", setPressed, NSString *) {
  self.view.pressedValue = value;
}

LYNX_PROP_SETTER("sessions-label", setSessionsLabel, NSString *) {
  [self.view setSessionsLabel:value ?: @"Sessions"];
}

LYNX_PROP_SETTER("settings-label", setSettingsLabel, NSString *) {
  [self.view setSettingsLabel:value ?: @"Settings"];
}

@end
