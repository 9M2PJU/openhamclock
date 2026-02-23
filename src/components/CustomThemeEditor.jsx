import { HexColorPicker, RgbaColorPicker } from 'react-colorful';
import { THEME_COLOR_CONFIG } from '../theme/themeConfig';

export default function CustomThemeEditor({ id, customTheme, updateCustomVar }) {
  return (
    <div id={id} style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
      {Object.entries(THEME_COLOR_CONFIG).map(([key, cfg]) => {
        const Picker = cfg.alpha ? RgbaColorPicker : HexColorPicker;

        return (
          <div key={key} className={`custom-theme-colorpicker ${cfg.hueRestrict !== null ? 'hue-locked' : ''}`}>
            <label>{cfg.label}</label>
            <Picker
              color={customTheme[key]}
              onChange={(color) => {
                updateCustomVar(key, color);
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
