import type { PressableProps } from 'react-native';

import { IconButton } from '@/components/ui/icon-button';

export function FloatingActionButton({
  label,
  icon = 'plus',
  ...props
}: Omit<PressableProps, 'children'> & { label: string; icon?: string }) {
  return (
    <IconButton
      {...props}
      label={label}
      icon={icon}
      variant="accent"
      size={58}
      iconSize={25}
      enteringVariant="zoom"
      enteringDelay={140}
      style={(state) => [
        {
          boxShadow: '0 4px 14px rgba(25,27,32,0.28)',
          opacity: state.pressed ? 0.82 : 1,
        },
        typeof props.style === 'function' ? props.style(state) : props.style,
      ]}
    />
  );
}
