import { icons } from "./assets";

export function Icon({ name }: { name: keyof typeof icons }) {
	return <img className="dl-icon" src={icons[name]} alt="" aria-hidden="true" width="20" height="20" />;
}
