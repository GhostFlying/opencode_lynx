// Lynx native module exposing host capabilities (navigation, storage,
// network, SSE) to the JS layer.
//
// JS calls: NativeModules.nativeBridge.call(methodName, { containerID, protocolVersion, data }, callback)
// This module dispatches to service implementations based on methodName.

#import "OpenCodeBridgeModule.h"
#import <Lynx/LynxContext.h>
#import "OpenCodeLynx-Swift.h"

// Success/failure/no-handler codes are owned by `OpenCodeBridgeDispatcher`
// in Swift; only the invalid-param code is used directly from this file
// (for the early-return when the JS caller passes an empty method name).
static NSInteger const kCodeInvalidParam = -3;

@interface OpenCodeBridgeModule ()
@property (nonatomic, weak) LynxContext *lynxContext;
@property (nonatomic, strong) OpenCodeBridgeDispatcher *dispatcher;
@end

@implementation OpenCodeBridgeModule

#pragma mark - LynxContextModule

+ (NSString *)name {
    return @"nativeBridge";
}

+ (NSDictionary<NSString *, NSString *> *)methodLookup {
    return @{
        @"call": NSStringFromSelector(@selector(call:params:callback:))
    };
}

- (instancetype)initWithLynxContext:(LynxContext *)context {
    self = [super init];
    if (self) {
        _lynxContext = context;
        _dispatcher = [[OpenCodeBridgeDispatcher alloc] initWithLynxContext:context];
    }
    return self;
}

#pragma mark - Bridge call

- (void)call:(NSString *)methodName
      params:(NSDictionary *)params
    callback:(LynxCallbackBlock)callback {

    if (!methodName || methodName.length == 0) {
        if (callback) {
            callback([self responseWithCode:kCodeInvalidParam msg:@"Missing method name" data:nil]);
        }
        return;
    }

    // Extract actual data payload from the envelope
    NSDictionary *data = nil;
    id rawData = params[@"data"];
    if ([rawData isKindOfClass:[NSDictionary class]]) {
        data = rawData;
    }

    [_dispatcher dispatchMethod:methodName
                         params:data ?: @{}
                     completion:^(NSInteger code, NSString * _Nullable msg, NSDictionary * _Nullable resultData) {
        if (callback) {
            callback([self responseWithCode:code msg:msg data:resultData]);
        }
    }];
}

#pragma mark - Response helpers

- (NSDictionary *)responseWithCode:(NSInteger)code
                               msg:(NSString *)msg
                              data:(NSDictionary *)data {
    NSMutableDictionary *response = [NSMutableDictionary dictionary];
    response[@"code"] = @(code);
    if (msg) response[@"msg"] = msg;
    if (data) response[@"data"] = data;
    response[@"protocolVersion"] = @"1.1.0";
    return [response copy];
}

@end
