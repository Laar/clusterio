import { useContext, useEffect, useState } from "react";

import { libData, libLink, libLogging } from "@clusterio/lib";

import ControlContext from "../components/ControlContext";

const { logger } = libLogging;

export function useModPack(id) {
	let control = useContext(ControlContext);
	let [modPack, setModPack] = useState({ loading: true });

	function updateModPack() {
		libLink.messages.getModPack.send(control, { id }).then(result => {
			setModPack(new libData.ModPack(result.mod_pack));
		}).catch(err => {
			logger.error(`Failed to get mod pack: ${err}`);
			setModPack({ missing: true });
		});
	}

	useEffect(() => {
		if (typeof id !== "number") {
			setModPack({ missing: true });
			return undefined;
		}
		updateModPack();

		control.onModPackUpdate(id, setModPack);
		return () => {
			control.offModPackUpdate(id, setModPack);
		};
	}, [id]);

	return [modPack];
}

export function useModPackList() {
	let control = useContext(ControlContext);
	let [modPackList, setModPackList] = useState([]);

	function updateModPackList() {
		libLink.messages.listModPacks.send(control).then(result => {
			setModPackList(result.list.map(pack => new libData.ModPack(pack)));
		}).catch(err => {
			logger.error(`Failed to list mod packs:\n${err}`);
		});
	}

	useEffect(() => {
		updateModPackList();

		function updateHandler(newModPack) {
			setModPackList(oldList => {
				let newList = oldList.concat();
				let index = newList.findIndex(u => u.id === newModPack.id);
				if (!newModPack.isDeleted) {
					if (index !== -1) {
						newList[index] = newModPack;
					} else {
						newList.push(newModPack);
					}
				} else if (index !== -1) {
					newList.splice(index, 1);
				}
				return newList;
			});
		}

		control.onModPackUpdate(null, updateHandler);
		return () => {
			control.offModPackUpdate(null, updateHandler);
		};
	}, []);

	return [modPackList];

}