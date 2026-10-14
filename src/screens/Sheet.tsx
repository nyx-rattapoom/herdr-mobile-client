import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets, type EdgeInsets } from 'react-native-safe-area-context';

import { sheet } from './ui';

/**
 * Modal windows are edge-to-edge and don't get the root SafeAreaView's padding, so every overlay
 * keeps its content off the system bars itself. The backdrop still dims the whole screen; the
 * panel's background runs under the bottom bar while its rows stay above it. In landscape the
 * navigation bar can sit on either side, hence the left/right padding.
 */
export function overlayInsets(insets: EdgeInsets, panelBottom: number = sheet.panel.paddingBottom) {
  return {
    backdrop: { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right },
    panel: { paddingBottom: panelBottom + insets.bottom },
  };
}

/** A bottom sheet in its own modal: tap outside to close. */
export function BottomSheet({
  onClose,
  animation = 'slide',
  testID,
  backdropTestID = 'sheet-backdrop',
  style,
  children,
}: {
  onClose: () => void;
  animation?: 'slide' | 'fade';
  testID?: string;
  backdropTestID?: string;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const pad = overlayInsets(useSafeAreaInsets());
  return (
    <Modal transparent statusBarTranslucent navigationBarTranslucent animationType={animation} onRequestClose={onClose}>
      <Pressable style={[sheet.backdrop, pad.backdrop]} onPress={onClose} testID={backdropTestID}>
        {/* A Pressable (not a View) so taps inside the panel don't reach the backdrop. */}
        <Pressable style={[sheet.panel, style, pad.panel]} testID={testID}>
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** A dialog centred in its own modal that moves up for the keyboard. */
export function CenteredDialog({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal transparent statusBarTranslucent navigationBarTranslucent animationType="fade" onRequestClose={onClose}>
      {/* The inset padding sits outside the KeyboardAvoidingView, which overwrites its own
          paddingBottom; it then only adds the part of the keyboard above the navigation bar. */}
      <View
        style={[
          sheet.backdrop,
          {
            paddingTop: 16 + insets.top,
            paddingBottom: 16 + insets.bottom,
            paddingLeft: 16 + insets.left,
            paddingRight: 16 + insets.right,
          },
        ]}
      >
        <KeyboardAvoidingView behavior="padding" style={{ flex: 1, justifyContent: 'center' }}>
          {children}
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}
