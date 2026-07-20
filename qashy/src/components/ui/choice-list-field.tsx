import { useMemo, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { IconButton } from '@/components/ui/icon-button';
import { MotionPressable, MotionView } from '@/components/ui/motion';
import { useLocalization } from '@/localization/localization';
import { useQashyTheme } from '@/theme/theme';
import { radius } from '@/theme/tokens';

export type ChoiceListOption = {
  value: string;
  label: string;
  description?: string;
};

export function ChoiceListField({
  label,
  value,
  options,
  onChange,
  hint,
  searchable = false,
  literalOptions = false,
  searchPlaceholder = 'Search',
}: {
  label: string;
  value: string;
  options: ChoiceListOption[];
  onChange: (value: string) => void;
  hint?: string;
  searchable?: boolean;
  /**
   * Set when the options are data rather than UI copy — currency names and
   * codes, or any list built from stored entities. The field's own `label`,
   * `hint`, and chrome stay translated either way.
   */
  literalOptions?: boolean;
  searchPlaceholder?: string;
}) {
  const theme = useQashyTheme();
  const { isRtl, t } = useLocalization();
  const { height } = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Falling back to options[0] used to show the first option as if it were
  // chosen while the list rendered no checkmark anywhere.
  const selected = options.find((option) => option.value === value);
  const placeholder = t('Select an option');
  const optionText = (text: string) => (literalOptions ? text : t(text));
  // Resolved here rather than in AppText so the placeholder (already
  // translated) and a data-backed option label can share one text node.
  const triggerText = selected ? optionText(selected.label) : placeholder;
  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return options;
    return options.filter((option) =>
      `${option.label} ${option.description ?? ''} ${option.value}`
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    );
  }, [options, query]);

  const close = () => {
    setOpen(false);
    setQuery('');
  };

  return (
    <View style={{ gap: 7 }}>
      <AppText variant="label">{label}</AppText>
      <MotionPressable
        accessibilityLabel={t(label)}
        accessibilityHint={t('Opens a list of choices')}
        accessibilityRole="button"
        accessibilityValue={{ text: triggerText }}
        onPress={() => setOpen(true)}
        style={({ pressed }) => ({
          minHeight: 50,
          paddingHorizontal: 15,
          paddingVertical: 10,
          borderRadius: 16,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: open ? theme.accent : theme.border,
          backgroundColor: pressed ? theme.surfaceMuted : theme.surface,
            flexDirection: isRtl ? 'row-reverse' : 'row',
          alignItems: 'center',
          gap: 12,
        })}>
        <View style={{ flex: 1, gap: 1 }}>
          <AppText literal muted={!selected}>{triggerText}</AppText>
          {selected?.description ? <AppText literal={literalOptions} variant="caption" muted>{selected.description}</AppText> : null}
        </View>
        <AppIcon name="chevron.down" color={theme.textMuted} size={18} />
      </MotionPressable>

      {hint ? (
        <MotionView key={hint} variant="right" exit animateLayout>
          <AppText selectable variant="caption" muted>{hint}</AppText>
        </MotionView>
      ) : null}

      <Modal
        animationType="fade"
        transparent
        visible={open}
        onRequestClose={close}>
        <SafeAreaView
          edges={['top', 'right', 'bottom', 'left']}
          style={{ flex: 1, justifyContent: 'center', padding: 18 }}>
          <Pressable
            accessibilityLabel={t(`Close ${label.toLocaleLowerCase()} choices`)}
            accessibilityRole="button"
            onPress={close}
            style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.46)' }}
          />
          <MotionView
            accessibilityViewIsModal
            importantForAccessibility="yes"
            variant="zoom"
            style={{
              width: '100%',
              maxWidth: 520,
              maxHeight: Math.max(320, height - 72),
              alignSelf: 'center',
              padding: 18,
              gap: 14,
              borderRadius: radius.card,
              borderCurve: 'continuous',
              borderWidth: 1,
              borderColor: theme.border,
              backgroundColor: theme.surface,
              boxShadow: '0 14px 48px rgba(0,0,0,0.24)',
            }}>
            <View style={{ minHeight: 44, flexDirection: isRtl ? 'row-reverse' : 'row', alignItems: 'center', gap: 12 }}>
              <View style={{ flex: 1, gap: 2 }}>
                {/* Built as one string: separate children are translated
                    individually, so "Choose " and "language" would each miss
                    the dictionary and never resolve. */}
                <AppText variant="headline">{`Choose ${label.toLocaleLowerCase()}`}</AppText>
                <AppText variant="caption" muted>{`${options.length} choices available`}</AppText>
              </View>
              <IconButton label={`Close ${label.toLocaleLowerCase()} choices`} icon="xmark" onPress={close} />
            </View>

            {searchable ? (
              <View style={{ position: 'relative', justifyContent: 'center' }}>
                <View style={{ position: 'absolute', left: 14, zIndex: 1 }}>
                  <AppIcon name="magnifyingglass" color={theme.textMuted} size={18} />
                </View>
                <TextInput
                  accessibilityLabel={t(`Search ${label.toLocaleLowerCase()}`)}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder={t(searchPlaceholder)}
                  placeholderTextColor={theme.textMuted}
                  value={query}
                  onChangeText={setQuery}
                  style={{
                    minHeight: 48,
                    paddingLeft: 42,
                    paddingRight: 14,
                    borderRadius: 15,
                    borderCurve: 'continuous',
                    borderWidth: 1,
                    borderColor: theme.border,
                    backgroundColor: theme.surfaceMuted,
                    color: theme.text,
                    fontSize: 16,
                    writingDirection: isRtl ? 'rtl' : 'ltr',
                    textAlign: isRtl ? 'right' : 'left',
                  }}
                />
              </View>
            ) : null}

            <View
              accessibilityRole="radiogroup"
              // Deliberately not `label`: the trigger button already carries
              // that, and two elements sharing one accessible name leaves a
              // screen reader unable to tell the closed field from the open
              // list. Matches the dialog heading above instead.
              accessibilityLabel={t(`Choose ${label.toLocaleLowerCase()}`)}
              // Announces "3 choices available" style updates as the query
              // narrows the list, including when it empties out.
              accessibilityLiveRegion="polite"
              aria-live="polite"
              style={{ flexShrink: 1 }}>
              <FlatList
                data={filteredOptions}
                keyExtractor={(option) => option.value}
                keyboardShouldPersistTaps="handled"
                initialNumToRender={18}
                ItemSeparatorComponent={() => <View style={{ height: 6 }} />}
                ListEmptyComponent={(
                  <View style={{ paddingVertical: 28, alignItems: 'center' }}>
                    <AppText muted>No matching choices</AppText>
                  </View>
                )}
                renderItem={({ item }) => {
                  const isSelected = item.value === value;
                  return (
                    <MotionPressable
                      accessibilityRole="radio"
                      accessibilityState={{ selected: isSelected }}
                      onPress={() => {
                        onChange(item.value);
                        close();
                      }}
                      active={isSelected}
                      style={({ pressed }) => ({
                        minHeight: 52,
                        paddingHorizontal: 14,
                        paddingVertical: 10,
                        borderRadius: radius.control,
                        borderCurve: 'continuous',
                        backgroundColor: isSelected
                          ? theme.accentContainer
                          : pressed
                            ? theme.surfaceMuted
                            : 'transparent',
                        flexDirection: isRtl ? 'row-reverse' : 'row',
                        alignItems: 'center',
                        gap: 12,
                      })}>
                      <View style={{ flex: 1, gap: 1 }}>
                        <AppText literal={literalOptions} variant={isSelected ? 'label' : 'body'}>{item.label}</AppText>
                        {item.description ? <AppText literal={literalOptions} variant="caption" muted>{item.description}</AppText> : null}
                      </View>
                      {isSelected ? <AppIcon name="checkmark" color={theme.accent} size={20} /> : null}
                    </MotionPressable>
                  );
                }}
              />
            </View>
          </MotionView>
        </SafeAreaView>
      </Modal>
    </View>
  );
}
