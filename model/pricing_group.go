package model

import (
	"errors"
	"maps"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"gorm.io/gorm"
)

const groupRatioOptionKey = "GroupRatio"

// EnsurePricingGroupWithTx adds a default-priced group to the persisted group
// ratios within the caller's transaction. Existing group prices are preserved.
func EnsurePricingGroupWithTx(tx *gorm.DB, groupName string) (string, bool, error) {
	var option Option
	err := lockForUpdate(tx).Where("key = ?", groupRatioOptionKey).First(&option).Error
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return "", false, err
	}
	optionExists := err == nil

	runtimeGroupRatios := ratio_setting.GetGroupRatioCopy()
	var groupRatios map[string]float64
	if optionExists {
		if err := common.UnmarshalJsonStr(option.Value, &groupRatios); err != nil {
			return "", false, err
		}
	} else {
		groupRatios = runtimeGroupRatios
	}
	if groupRatios == nil {
		groupRatios = make(map[string]float64)
	}
	if _, exists := groupRatios[groupName]; exists {
		if optionExists && !maps.Equal(runtimeGroupRatios, groupRatios) {
			return option.Value, true, nil
		}
		return "", false, nil
	}

	groupRatios[groupName] = 1
	value, err := common.Marshal(groupRatios)
	if err != nil {
		return "", false, err
	}
	option.Key = groupRatioOptionKey
	option.Value = string(value)
	if optionExists {
		err = tx.Save(&option).Error
	} else {
		err = tx.Create(&option).Error
	}
	if err != nil {
		return "", false, err
	}
	return option.Value, true, nil
}

// PublishPricingGroupConfig updates the process-local settings after the
// transaction that persisted the new group has committed.
func PublishPricingGroupConfig(value string) error {
	if err := updateOptionMap(groupRatioOptionKey, value); err != nil {
		return err
	}
	BumpSyncTopic(SyncTopicOptions)
	return nil
}
