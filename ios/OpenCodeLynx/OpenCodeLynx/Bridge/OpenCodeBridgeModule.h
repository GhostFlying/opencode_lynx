// Lynx native module exposing host capabilities (navigation, storage,
// network, SSE) to the JS layer.
//
// Registers as "nativeBridge" to match the JS native-bridge.ts module name.
// Routes method names (network.request, storage.get, etc.) to service implementations.
// Callback format: { code: 1 (success) / 0 (fail), msg, data, containerID, protocolVersion }

#import <Foundation/Foundation.h>
#import <Lynx/LynxContextModule.h>

NS_ASSUME_NONNULL_BEGIN

@interface OpenCodeBridgeModule : NSObject <LynxContextModule>

@end

NS_ASSUME_NONNULL_END
