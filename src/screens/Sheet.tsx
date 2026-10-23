import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets, type EdgeInsets } from 'react-native-safe-area-context';

import { sheet } from './ui';

export function overlayInsets(insets: EdgeInsets, panelBottom: number = sheet.panel.paddingBottom) {
  return {
    backdrop: { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right },
    panel: { paddingBottom: panelBottom + insets.bottom },
  };
}

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
        <Pressable style={[sheet.panel, { maxHeight: '100%' }, style, pad.panel]} testID={testID}>
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export function CenteredDialog({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal transparent statusBarTranslucent navigationBarTranslucent animationType="fade" onRequestClose={onClose}>
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
