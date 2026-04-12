// Copyright 2025 The OpenCode Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

#import "OpenCodeSVGRenderer.h"
#import <dlfcn.h>

typedef const void *CGSVGDocumentRef;

static CGSVGDocumentRef (*_CGSVGDocumentCreateFromData)(CFDataRef, CFDictionaryRef) = NULL;
static void (*_CGSVGDocumentRelease)(CGSVGDocumentRef) = NULL;
static CGSize (*_CGSVGDocumentGetCanvasSize)(CGSVGDocumentRef) = NULL;
static void (*_CGContextDrawSVGDocument)(CGContextRef, CGSVGDocumentRef) = NULL;

static BOOL _coreSVGAvailable = NO;

static void OpenCodeLoadCoreSVGIfNeeded(void) {
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    void *handle = RTLD_DEFAULT;
    _CGSVGDocumentCreateFromData =
        (CGSVGDocumentRef (*)(CFDataRef, CFDictionaryRef))dlsym(handle, "CGSVGDocumentCreateFromData");
    _CGSVGDocumentRelease = (void (*)(CGSVGDocumentRef))dlsym(handle, "CGSVGDocumentRelease");
    _CGSVGDocumentGetCanvasSize =
        (CGSize (*)(CGSVGDocumentRef))dlsym(handle, "CGSVGDocumentGetCanvasSize");
    _CGContextDrawSVGDocument =
        (void (*)(CGContextRef, CGSVGDocumentRef))dlsym(handle, "CGContextDrawSVGDocument");

    _coreSVGAvailable = _CGSVGDocumentCreateFromData != NULL &&
                        _CGSVGDocumentRelease != NULL &&
                        _CGSVGDocumentGetCanvasSize != NULL &&
                        _CGContextDrawSVGDocument != NULL;
  });
}

UIImage *_Nullable OpenCodeRenderSVGContent(NSString *_Nullable svgXML) {
  if (svgXML.length == 0) {
    return nil;
  }

  OpenCodeLoadCoreSVGIfNeeded();
  if (!_coreSVGAvailable) {
    return nil;
  }

  NSData *data = [svgXML dataUsingEncoding:NSUTF8StringEncoding];
  if (data == nil) {
    return nil;
  }

  CGSVGDocumentRef document = _CGSVGDocumentCreateFromData((__bridge CFDataRef)data, NULL);
  if (document == nil) {
    return nil;
  }

  CGSize canvasSize = _CGSVGDocumentGetCanvasSize(document);
  if (canvasSize.width <= 0 || canvasSize.height <= 0) {
    _CGSVGDocumentRelease(document);
    return nil;
  }

  CGFloat scale = UIScreen.mainScreen.scale;
  UIGraphicsBeginImageContextWithOptions(canvasSize, NO, scale);
  CGContextRef context = UIGraphicsGetCurrentContext();
  if (context != nil) {
    // CoreGraphics uses a bottom-left origin; flip to UIKit coordinates.
    CGContextTranslateCTM(context, 0, canvasSize.height);
    CGContextScaleCTM(context, 1, -1);
    _CGContextDrawSVGDocument(context, document);
  }
  UIImage *image = UIGraphicsGetImageFromCurrentImageContext();
  UIGraphicsEndImageContext();

  _CGSVGDocumentRelease(document);
  return image;
}
