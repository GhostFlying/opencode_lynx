// Copyright 2025 The OpenCode Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.
import type { BaseEvent, StandardProps, TouchEvent } from '@lynx-js/types';

declare module '@lynx-js/types' {
  interface GlobalProps {
    preferredTheme?: string;
    theme: string;
    isNotchScreen: boolean;
    safeAreaInsets?: {
      top?: number | string;
      right?: number | string;
      bottom?: number | string;
      left?: number | string;
    };
  }

  interface IntrinsicElements extends Lynx.IntrinsicElements {
    input: InputProps;
    textarea: TextareaProps;
    'x-liquid-glass': LiquidGlassProps;
    'x-native-tabbar': NativeTabbarProps;
  }

  interface ListProps {
    'ios-fix-offset-from-start'?: boolean;
  }
}

export interface InputProps extends StandardProps {
  /**
   * CSS class name for the input element
   */
  className?: string;

  value?: string;

  /**
   * Event handler for input changes
   */
  bindinput?: (e: InputEvent) => void;

  /**
   * Event handler for blur events
   */
  bindblur?: (e: BlurEvent) => void;

  /**
   * Placeholder text when input is empty
   */
  placeholder?: string;

  /**
   * Text color of the input
   */
  'text-color'?: string;
}

export type InputEvent = BaseEvent<'input', { value: string }>;

export interface TextareaProps extends StandardProps {
  className?: string;
  value?: string;
  bindinput?: (e: TextareaInputEvent) => void;
  bindblur?: (e: BaseEvent<'blur', { value: string }>) => void;
  bindfocus?: (e: BaseEvent<'focus', { value: string }>) => void;
  bindconfirm?: (e: BaseEvent<'confirm', { value: string }>) => void;
  placeholder?: string;
  maxlines?: number;
  maxlength?: number;
  disabled?: boolean;
  'confirm-type'?: 'search' | 'send' | 'go' | 'done' | 'next';
}

export interface LiquidGlassProps extends StandardProps {
  className?: string;
  variant?: 'bar' | 'card';
  'corner-radius'?: string;
  'tint-alpha'?: string;
}

export type NativeTabChangeEvent = BaseEvent<'tabchange', {
  value: 'sessions' | 'settings';
}>;

export interface NativeTabbarProps extends StandardProps {
  className?: string;
  selected?: 'sessions' | 'settings';
  pressed?: 'sessions' | 'settings' | '';
  'sessions-label'?: string;
  'settings-label'?: string;
  bindtabchange?: (event: NativeTabChangeEvent) => void;
  bindtouchstart?: (event: TouchEvent) => void;
  bindtouchmove?: (event: TouchEvent) => void;
  bindtouchend?: (event: TouchEvent) => void;
  bindtouchcancel?: (event: TouchEvent) => void;
}

export type TextareaInputEvent = BaseEvent<'input', {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  isComposing?: boolean;
}>;
